#!/usr/bin/env node
// Regenerates the synthetic signed PDFs in tests/fixtures/signatures. They mirror
// an e-Aadhaar's structure (RC4-128 user password, one whole-file detached
// SHA-256 signature, embedded three-certificate chain) with throwaway test keys,
// so no real document or personal data is ever committed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const outputDir = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../tests/fixtures/signatures'));
const USER_PASSWORD = 'fixture-user';
const OWNER_PASSWORD = 'fixture-owner';
const PERMISSIONS = -3904;
const CONTENTS_BYTES = 8192;
const PAD = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');

const work = mkdtempSync(join(tmpdir(), 'pdfchef-signature-fixtures-'));
const openssl = (...args) => execFileSync('openssl', args, { cwd: work, stdio: 'pipe' });
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();

function makeCertificates() {
  const validity = ['-not_before', '20260101000000Z', '-not_after', '20460101000000Z'];
  writeFileSync(join(work, 'ca.ext'), [
    '[root]', 'basicConstraints=critical,CA:true', 'keyUsage=critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier=hash',
    '[intermediate]', 'basicConstraints=critical,CA:true,pathlen:0',
    'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid',
    '[leaf]', 'basicConstraints=critical,CA:false',
    'keyUsage=critical,digitalSignature,nonRepudiation', 'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid', '',
  ].join('\n'));
  for (const name of ['root', 'intermediate', 'leaf']) {
    openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', `${name}.key`);
  }
  openssl('req', '-new', '-x509', '-key', 'root.key', '-subj', '/C=IN/O=PDF Chef Test PKI/CN=PDF Chef Test Root',
    '-sha256', ...validity, '-extensions', 'root', '-config', 'ca.ext', '-out', 'root.pem');
  for (const [name, issuer, cn, serial] of [
    ['intermediate', 'root', 'PDF Chef Test Document Signing CA', '2'],
    ['leaf', 'intermediate', 'DS PDF Chef Test Signer 01', '3'],
  ]) {
    openssl('req', '-new', '-key', `${name}.key`, '-subj', `/C=IN/O=PDF Chef Test PKI/CN=${cn}`, '-out', `${name}.csr`);
    openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`,
      '-set_serial', serial, '-sha256', ...validity, '-extfile', 'ca.ext', '-extensions', name, '-out', `${name}.pem`);
  }
  writeFileSync(join(work, 'chain.pem'),
    readFileSync(join(work, 'intermediate.pem')) + readFileSync(join(work, 'root.pem')));
}

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const output = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    output[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return output;
}

const padded = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);

// PDF 1.7 standard security handler, revision 3 (algorithms 2, 3 and 5).
function standardSecurity(id, userPassword) {
  let ownerKey = md5(padded(OWNER_PASSWORD));
  for (let i = 0; i < 50; i += 1) ownerKey = md5(ownerKey);
  let owner = rc4(ownerKey, padded(userPassword));
  for (let i = 1; i <= 19; i += 1) owner = rc4(ownerKey.map((byte) => byte ^ i), owner);

  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(PERMISSIONS);
  let fileKey = md5(padded(userPassword), owner, permissions, id);
  for (let i = 0; i < 50; i += 1) fileKey = md5(fileKey);

  let user = rc4(fileKey, md5(PAD, id));
  for (let i = 1; i <= 19; i += 1) user = rc4(fileKey.map((byte) => byte ^ i), user);
  return { owner, user: Buffer.concat([user, Buffer.alloc(16)]), fileKey };
}

function layeredAppearance(first, stream, { hexStatus = false } = {}) {
  const form = (box, resources = '') => `/Type /XObject /Subtype /Form /BBox [${box}] ${resources}`;
  const font = `/Resources << /Font << /F1 ${first + 7} 0 R >> >> `;
  return [
    stream(form('0 0 50 30', `/Resources << /XObject << /FRM ${first + 1} 0 R >> >> `), 'q 1 0 0 1 0 0 cm /FRM Do Q\n'),
    stream(form('0 0 50 30', `/Resources << /XObject << /n0 ${first + 2} 0 R /n1 ${first + 3} 0 R `
      + `/n2 ${first + 4} 0 R /n3 ${first + 5} 0 R /n4 ${first + 6} 0 R >> >> `),
    'q 1 0 0 1 0 0 cm /n0 Do Q\nq 0.27 0 0 0.27 11.5 1.5 cm /n1 Do Q\nq 1 0 0 1 0 0 cm /n2 Do Q\n'
      + 'q 0.27 0 0 0.27 11.5 1.5 cm /n3 Do Q\nq 1 0 0 1 0 0 cm /n4 Do Q\n'),
    stream(form('0 0 100 100'), '% DSBlank\n'),
    stream(form('0 0 100 100'), '% DSUnknown\nq 1 0.85 0.2 rg 35 20 30 60 re f Q\n'),
    stream(form('0 0 50 30', font), 'BT\n1 0 0 1 2 15.6 Tm\n/F1 3.4 Tf\n(Digitally signed by DS PDF Chef)Tj\n'
      + '1 0 0 1 2 12.2 Tm\n(Test Signer 01)Tj\nET\n'),
    stream(form('0 0 100 100'), '% DSBlank\n'),
    // A hex-string status cannot be rewritten safely, so a verified copy must refuse it.
    stream(form('0 21 50 30', font), `BT\n1 0 0 1 2 23.3 Tm\n/F1 4.7 Tf\n${hexStatus
      ? `<${Buffer.from('Signature Not Verified', 'latin1').toString('hex')}>` : '(Signature Not Verified)'}Tj\nET\n`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
}

function signedPdf({
  encrypted, subFilter, cades, shadow = false, wideGap = false, indirectComment = false, layered = false,
  offset = false, unsignedBox = false, hexStatus = false, updateContents = false, ownerOnly = false,
  stateBox = false,
}) {
  const id = createHash('md5').update(`pdfchef-signature-fixture-${subFilter}-${encrypted}`).digest();
  // An owner-only PDF has an empty user password, so it opens without asking for one.
  const security = encrypted ? standardSecurity(id, ownerOnly ? '' : USER_PASSWORD) : null;
  const objectKey = (number) => md5(security.fileKey, Buffer.from([number & 0xff, (number >> 8) & 0xff,
    (number >> 16) & 0xff, 0, 0])).subarray(0, 16);
  const string = (number, text) => (encrypted
    ? `<${rc4(objectKey(number), Buffer.from(text, 'latin1')).toString('hex')}>` : `(${text})`);
  const stream = (dictionary, text) => ({ dictionary, data: Buffer.from(text, 'latin1') });

  const byteRangePlaceholder = '/ByteRange [0 0000000000 0000000000 0000000000]';
  const contentsPlaceholder = `<${'0'.repeat(CONTENTS_BYTES * 2)}>`;
  // The layered appearance (n0-n4 inside FRM) follows the base objects and any extra string.
  const appearance = (encrypted ? 8 : 7) + (shadow || indirectComment ? 1 : 0);
  // An offset page starts at (100, 100); an unsigned box is a second, never-signed signature field.
  const origin = offset ? 100 : 0;
  const unsignedWidget = appearance + 8;
  const widgetBox = layered
    ? `/Rect [${20 + origin} ${100 + origin} ${70 + origin} ${130 + origin}] /AP << /N ${appearance} 0 R >>`
    : '/Rect [0 0 0 0]';
  const extraField = unsignedBox ? ` ${unsignedWidget} 0 R` : '';
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R${extraField}] /SigFlags 3 >> >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [${origin} ${origin} ${200 + origin} ${200 + origin}] `
      + `/Contents 6 0 R /Annots [4 0 R${extraField}] >>`,
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T ${string(4, 'Signature1')} ${widgetBox} /F 132 /P 3 0 R /V 5 0 R >>`,
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter} ${byteRangePlaceholder} `
      + `/Contents ${shadow ? '<00>' : indirectComment ? `${encrypted ? 8 : 7} 0 R` : contentsPlaceholder} `
      + `/M ${string(5, 'D:20260927000000Z')} >>`,
    stream('', `0.1 0.4 0.8 rg ${20 + origin} ${20 + origin} 160 160 re f\n`),
    ...(encrypted ? [`<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${PERMISSIONS} `
      + `/O <${security.owner.toString('hex')}> /U <${security.user.toString('hex')}> >>`] : []),
    // A shadow layout: /ByteRange skips a string that is not the dictionary's /Contents.
    ...(shadow ? [contentsPlaceholder] : []),
    // An indirect /Contents whose string follows a comment that merely mentions the key.
    ...(indirectComment ? [`% /Contents\n${contentsPlaceholder}`] : []),
    // The Acrobat layered signature appearance iText writes, as in a UIDAI e-Aadhaar.
    ...(layered ? layeredAppearance(appearance, stream, { hexStatus }) : []),
    ...(unsignedBox ? [
      `<< /Type /Annot /Subtype /Widget /FT /Sig /T ${string(unsignedWidget, 'Signature2')} `
        + `/Rect [${120 + origin} ${100 + origin} ${170 + origin} ${130 + origin}] /F 132 /P 3 0 R `
        // A state-keyed appearance is drawn by viewers but cannot be redrawn as a single form.
        + `/AP << /N ${stateBox ? `<< /On ${unsignedWidget + 1} 0 R >>` : `${unsignedWidget + 1} 0 R`} >> >>`,
      ...layeredAppearance(unsignedWidget + 1, stream),
    ] : []),
  ];

  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const number = index + 1;
    const data = typeof body === 'string' ? null : encrypted ? rc4(objectKey(number), body.data) : body.data;
    const chunk = data === null
      ? Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${number} 0 obj\n<< /Length ${data.length} ${body.dictionary}>>\nstream\n`, 'latin1'),
        data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('');
  const encryption = encrypted ? '/Encrypt 7 0 R ' : '';
  const firstXref = length;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryption}`
    + `/ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));

  const pdf = Buffer.concat(parts);
  const contentsStart = pdf.indexOf(contentsPlaceholder);
  // A wide gap also leaves the dictionary's next entry unsigned.
  const contentsEnd = wideGap
    ? pdf.indexOf(' >>', contentsStart + contentsPlaceholder.length)
    : contentsStart + contentsPlaceholder.length;
  const range = [0, contentsStart, contentsEnd, pdf.length - contentsEnd];
  pdf.write(`/ByteRange [0 ${range.slice(1).map((value) => String(value).padStart(10, '0')).join(' ')}]`,
    pdf.indexOf(byteRangePlaceholder), 'latin1');

  writeFileSync(join(work, 'signed.bin'), Buffer.concat([pdf.subarray(0, range[1]), pdf.subarray(range[2])]));
  openssl('cms', '-sign', '-binary', '-in', 'signed.bin', '-signer', 'leaf.pem', '-inkey', 'leaf.key',
    '-certfile', 'chain.pem', '-md', 'sha256', '-nosmimecap', ...(cades ? ['-cades'] : []),
    '-outform', 'DER', '-out', 'signature.der');
  const signature = readFileSync(join(work, 'signature.der')).toString('hex');
  if (signature.length > CONTENTS_BYTES * 2) throw new Error('Signature does not fit its placeholder');
  pdf.write(signature, contentsStart + 1, 'latin1');
  if (!updateContents) return pdf;

  // An unsigned incremental update gives the signature dictionary a /Contents equal to the
  // excluded string, which is not itself the dictionary's value in the signed revision.
  const rangeText = pdf.subarray(pdf.indexOf('/ByteRange ['), pdf.indexOf(']', pdf.indexOf('/ByteRange [')) + 1)
    .toString('latin1');
  const body = `5 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter} ${rangeText} `
    + `/Contents ${pdf.subarray(contentsStart, contentsEnd).toString('latin1')} /M (D:20260927000000Z) >>\nendobj\n`;
  const updateXref = pdf.length + body.length;
  return Buffer.concat([pdf, Buffer.from(`${body}xref\n0 1\n0000000000 65535 f \n5 1\n`
    + `${String(pdf.length).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R `
    + `/Prev ${firstXref} /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${updateXref}\n%%EOF\n`,
  'latin1')]);
}

try {
  makeCertificates();
  mkdirSync(outputDir, { recursive: true });
  const fixtures = {
    'detached-sha256-rc4.pdf': { encrypted: true, subFilter: 'adbe.pkcs7.detached', cades: false },
    'cades-sha256-plain.pdf': { encrypted: false, subFilter: 'ETSI.CAdES.detached', cades: true },
    'shadow-gap-rc4.pdf': { encrypted: true, subFilter: 'adbe.pkcs7.detached', cades: false, shadow: true },
    'wide-gap-plain.pdf': { encrypted: false, subFilter: 'adbe.pkcs7.detached', cades: false, wideGap: true },
    'indirect-comment-plain.pdf': { encrypted: false, subFilter: 'adbe.pkcs7.detached', cades: false, indirectComment: true },
    'layered-appearance-rc4.pdf': { encrypted: true, subFilter: 'adbe.pkcs7.detached', cades: false, layered: true },
    'layered-mixed-offset-rc4.pdf': {
      encrypted: true, subFilter: 'adbe.pkcs7.detached', cades: false, layered: true, offset: true, unsignedBox: true,
    },
    'layered-hex-status-rc4.pdf': { encrypted: true, subFilter: 'adbe.pkcs7.detached', cades: false, layered: true, hexStatus: true },
    'layered-owner-only-rc4.pdf': {
      encrypted: true, subFilter: 'adbe.pkcs7.detached', cades: false, layered: true, ownerOnly: true,
    },
    'layered-state-box-rc4.pdf': {
      encrypted: true, subFilter: 'adbe.pkcs7.detached', cades: false, layered: true, unsignedBox: true, stateBox: true,
    },
    'shadow-update-plain.pdf': {
      encrypted: false, subFilter: 'adbe.pkcs7.detached', cades: false, shadow: true, updateContents: true,
    },
  };
  for (const [name, options] of Object.entries(fixtures)) {
    writeFileSync(join(outputDir, name), signedPdf(options));
  }
  writeFileSync(join(outputDir, 'test-root.der'), openssl('x509', '-in', 'root.pem', '-outform', 'DER'));
  console.log(`Wrote ${Object.keys(fixtures).length} signed PDFs and test-root.der to ${outputDir}; `
    + `encrypted user password: ${USER_PASSWORD}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
