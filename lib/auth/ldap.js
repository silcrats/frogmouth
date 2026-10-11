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

function createLdapAuth(opts) {
  const url = opts.url;
  const bindTemplate = opts.bind_template;
  const baseDn = opts.base_dn;
  const usernameAttr = opts.username_attr || 'sAMAccountName';

  function authenticate(username, password) {
    return new Promise((resolve, reject) => {
      const client = ldap.createClient({ url, timeout: 5000, connectTimeout: 5000 });
      client.on('error', reject);

      const bindDN = bindTemplate.replace('{username}', username);
      client.bind(bindDN, password, (bindErr) => {
        if (bindErr) {
          client.unbind();
          return reject(new Error('Invalid credentials'));
        }

        const searchOpts = {
          filter: `(${usernameAttr}=${escapeFilterValue(username)})`,
          scope: 'sub',
          attributes: ['memberOf', usernameAttr, 'displayName'],
        };

        client.search(baseDn, searchOpts, (searchErr, res) => {
          if (searchErr) {
            client.unbind();
            return reject(searchErr);
          }

          let groups = [];
          let displayName = null;
          res.on('searchEntry', (entry) => {
            const memberOf = entry.pojo.attributes.find(a => a.type === 'memberOf');
            if (memberOf) {
              groups = memberOf.values.map(dn => {
                // Extract the CN from a full group DN, e.g.
                // "CN=Domain Admins,CN=Users,DC=..." -> "Domain Admins"
                const match = /^CN=([^,]+)/i.exec(dn);
                return match ? match[1] : dn;
              });
            }
            const displayNameAttr = entry.pojo.attributes.find(a => a.type === 'displayName');
            if (displayNameAttr && displayNameAttr.values[0]) {
              displayName = displayNameAttr.values[0];
            }
          });
          res.on('error', (err) => {
            client.unbind();
            reject(err);
          });
          res.on('end', () => {
            client.unbind();
            // Not every account has displayName set -- fall back to the
            // username they signed in with rather than show a blank.
            resolve({ username, groups, displayName: displayName || username });
          });
        });
      });
    });
  }

  return { authenticate, describe: () => `LDAP at ${url}` };
}

module.exports = { createLdapAuth };
