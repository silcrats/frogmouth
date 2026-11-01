// Made-up documents for the stand-in OpenSearch, in the index's own field names.
// roles: Rguest is everyone, 1<user> one person, 2<group> a group.
const TYPES = ['pdf', 'docx', 'eml', 'xlsx'];
const DUPLICATE = 'Identical memo text. '.repeat(20);

function makeDocs() {
  const docs = [];
  for (let i = 0; i < 24; i++) {
    const date = new Date(Date.UTC(2015, 0, 1) + i * 86400000 * 45).toISOString();
    docs.push({
      url: `smb://srv/share/file${i}.${TYPES[i % 4]}`, title: `Report ${i}`, filename: `file${i}.pdf`, filetype: TYPES[i % 4],
      host: 'smb-share', share: 'share', timestamp: date, last_modified: date, content: `Body text of report ${i}`, role: ['Rguest'],
    });
  }
  const at = (i, fields) => Object.assign(docs[i], fields);
  at(0, { content: 'The audit committee reviewed procurement contracts and budget variance for the harbour dredging project. Alice Nguyen signed the audit procurement budget harbour dredging contracts.' });
  at(1, { content: 'Harbour dredging procurement audit: budget variance and contracts reviewed by the committee for the harbour project and dredging budget.' });
  at(2, { content: 'Vaccine trial enrolment cohort dosage results from the clinical vaccine trial and cohort enrolment dosage statistics.' });
  at(3, { title: '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>' });
  at(4, { content: 'Clinical cohort vaccine dosage enrolment and trial statistics reported in this vaccine cohort trial.' });
  delete docs[5].timestamp;
  at(6, { content: DUPLICATE });
  at(7, { content: DUPLICATE });
  // A thread by its reply headers, and an attachment.
  at(8, { email_subject: 'Budget review', email_from: 'carol@example.local', email_to: ['dan@example.local'], email_attachments: ['file10.pdf'], timestamp: '2016-01-01T00:00:00Z', email_message_id: '<t1@x>', email_thread_id: '<t1@x>' });
  at(9, { email_subject: 'CHANGED subject', email_from: 'dan@example.local', email_to: ['carol@example.local'], timestamp: '2016-01-02T00:00:00Z', email_message_id: '<t2@x>', email_in_reply_to: '<t1@x>', email_references: ['<t1@x>'], email_thread_id: '<t1@x>' });
  at(12, { filename: 'minutes.pdf' });
  at(13, { filename: 'minutes.pdf' });
  // The same subject between different people, with no reply headers: not a thread.
  at(14, { email_subject: 'Meeting', email_from: 'x@a' });
  at(15, { email_subject: 'Meeting', email_from: 'y@b' });
  // Numbered file names, as a mail archive has: coincidence, not a match.
  at(16, { filename: '5.eml' });
  at(17, { filename: '5.eml' });
  at(18, { email_subject: 'Vehicles', email_from: 'p@a', content: 'Subject: x\nFrom: a\n\nThe regulators may look closely at how we moved the exposure into outside vehicles this quarter, and whether anybody signed off on it properly before year end closed.' });
  at(19, { email_subject: 'Accounts', email_from: 'q@b', content: 'Subject: y\nFrom: b\n\nAuditors could question hiding those losses through partnerships, particularly the approvals that were or were not given, given when the accounts were finalised this time.' });
  // Only headers and routing addresses in common: mustn't relate them.
  at(20, { email_subject: 'a', email_from: 'john.arnold@x', content: 'Subject: z\nFrom: alice\nTo: bob\n\ntb + 9.5 for 250' });
  at(21, { email_subject: 'b', email_from: 'john.arnold@x', content: 'Subject: z2\nFrom: alice\nTo: bob\n\n----- Forwarded by john arnold/hou/ect on 1/1 -----\nFrom: john arnold\nTo: eric\nthat would be great' });

  // Vectors: 18 and 19 mean the same thing in different words, the rest nothing much.
  let seed = 3;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  const DIM = 32;
  const shared = Array.from({ length: DIM }, random);
  docs.forEach((doc, i) => {
    const own = Array.from({ length: DIM }, random);
    const knn = i === 18 || i === 19 ? shared.map((x, k) => x + own[k] * 0.1) : own;
    doc.content_embedding = [{ knn }, { knn }];
    doc.content_chunks = [`passage one of ${i}`, `passage two of ${i}`];
  });

  docs.push(
    { url: 'smb://srv/share/secret.pdf', title: 'SECRET TITLE', filename: 'secret.pdf', filetype: 'pdf', host: 'smb-share', share: 'share', timestamp: '2016-06-01T00:00:00Z', content: 'classified payroll figures', role: ['1alice'] },
    { url: 'smb://srv/finance/ledger.pdf', title: 'Finance ledger', filename: 'ledger.pdf', filetype: 'pdf', host: 'smb-share', share: 'finance', timestamp: '2016-07-01T00:00:00Z', content: 'finance only ledger entries', role: ['2Finance'] },
  );
  return docs;
}

module.exports = { makeDocs };
