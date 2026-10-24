const ldap = require('ldapjs');

// ---------------------------------------------------------------------
// LDAP: bind-authenticate the user, then resolve their group
// memberships from the SAME bound connection (works against AD without
// needing a separate service account, since a user can normally read
// their own memberOf attribute).
// ---------------------------------------------------------------------
// RFC 4515 escaping, so a username can't change the search filter's meaning.
function escapeFilterValue(value) {
  return String(value).replace(/[\\*()\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

// "CN=Domain Admins,CN=Users,DC=..." -> "Domain Admins"
function cnFromDn(dn) {
  const match = /^CN=([^,]+)/i.exec(dn);
  return match ? match[1] : dn;
}

// AD's primary group (usually Domain Users) is never listed in memberOf;
// the user carries its RID in primaryGroupID instead. Its SID is the
// user's own objectSid with the last sub-authority (the user's RID)
// replaced by that RID. Returned in string form (S-1-5-21-...-513), which
// AD and Samba both accept in a search filter. null if the SID is malformed.
function primaryGroupSid(userSid, rid) {
  if (!Buffer.isBuffer(userSid) || userSid.length < 8) return null;
  const count = userSid[1];
  if (count < 1 || userSid.length !== 8 + 4 * count) return null;
  const authority = userSid.readUIntBE(2, 6);
  const subs = [];
  for (let i = 0; i < count - 1; i++) subs.push(userSid.readUInt32LE(8 + 4 * i));
  return `S-${userSid[0]}-${authority}-${[...subs, rid].join('-')}`;
}

// One search on the bound client: resolves its entries' attributes, by
// type, as { values: [strings], buffers: [Buffers] }.
function search(client, baseDn, opts) {
  return new Promise((resolve, reject) => {
    client.search(baseDn, opts, (err, res) => {
      if (err) return reject(err);
      const entries = [];
      res.on('searchEntry', (entry) => {
        entries.push(Object.fromEntries(entry.attributes.map(a =>
          [a.type, { values: a.values, buffers: a.buffers }])));
      });
      res.on('error', reject);
      res.on('end', () => resolve(entries));
    });
  });
}

function createLdapAuth(opts) {
  const url = opts.url;
  const bindTemplate = opts.bind_template;
  const baseDn = opts.base_dn;
  const usernameAttr = opts.username_attr || 'sAMAccountName';

  // The CN of an AD user's primary group, or null if the directory doesn't
  // have one (not AD) or it can't be found. A failure only leaves the group
  // out, so the user sees less, never more.
  async function primaryGroup(client, user) {
    const rid = user.primaryGroupID && parseInt(user.primaryGroupID.values[0], 10);
    const sid = rid && user.objectSid && primaryGroupSid(user.objectSid.buffers[0], rid);
    if (!sid) return null;
    try {
      const [group] = await search(client, baseDn, { filter: `(objectSid=${sid})`, scope: 'sub', attributes: ['cn'] });
      return (group && group.cn && group.cn.values[0]) || null;
    } catch (err) {
      console.error(`LDAP: primary group ${sid} lookup failed: ${err.message}`);
      return null;
    }
  }

  function authenticate(username, password) {
    return new Promise((resolve, reject) => {
      const client = ldap.createClient({ url, timeout: 5000, connectTimeout: 5000 });
      client.on('error', reject);

      const bindDN = bindTemplate.replace('{username}', username);
      client.bind(bindDN, password, async (bindErr) => {
        if (bindErr) {
          client.unbind();
          return reject(new Error('Invalid credentials'));
        }

        try {
          const [user = {}] = await search(client, baseDn, {
            filter: `(${usernameAttr}=${escapeFilterValue(username)})`,
            scope: 'sub',
            attributes: ['memberOf', usernameAttr, 'displayName', 'primaryGroupID', 'objectSid'],
          });
          const groups = (user.memberOf ? user.memberOf.values : []).map(cnFromDn);
          const primary = await primaryGroup(client, user);
          if (primary && !groups.includes(primary)) groups.push(primary);
          // Not every account has displayName set -- fall back to the
          // username they signed in with rather than show a blank.
          const displayName = (user.displayName && user.displayName.values[0]) || username;
          resolve({ username, groups, displayName });
        } catch (err) {
          reject(err);
        } finally {
          client.unbind();
        }
      });
    });
  }

  return { authenticate, describe: () => `LDAP at ${url}` };
}

module.exports = { createLdapAuth };
