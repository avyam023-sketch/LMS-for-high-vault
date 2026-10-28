import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SHIELD, WORDMARK } from './logo-paths.js';
import { config } from '../config.js';

const require = createRequire(import.meta.url);
const fontDir = path.join(path.dirname(require.resolve('@fontsource/jost/package.json')), 'files');
const font = (w) => path.join(fontDir, `jost-latin-${w}-normal.woff`);

const RED = '#A3162C';
const INK = '#241517';
const WHITE = '#FFFFFF';
const SOFT = '#F0C6CE'; // frame and rules on the white side
const MUTED = '#6D5F62';

const fmt = (d) =>
  new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Toronto' });

export const verifyUrl = (code) => `${config.appUrl}/verify/${code}`;

/** Streams a landscape Letter certificate PDF for a certificate row. */
export async function renderCertificate(cert, stream) {
  const doc = new PDFDocument({
    size: 'LETTER',
    layout: 'landscape',
    margin: 0,
    info: { Title: `Certificate ${cert.code}`, Author: 'The High Vault Security', Subject: cert.course_title },
  });
  doc.pipe(stream);
  doc.registerFont('light', font(300));
  doc.registerFont('regular', font(400));
  doc.registerFont('medium', font(500));
  doc.registerFont('bold', font(600));

  const W = doc.page.width; // 792
  const H = doc.page.height; // 612

  // Brand panel
  const panel = 220;
  doc.rect(0, 0, panel, H).fill(RED);
  doc.save().translate(42, 110).scale(0.33).path(SHIELD).fill(WHITE, 'even-odd').restore();
  doc.save().translate(37, 290).scale(0.43).path(WORDMARK).fill(WHITE, 'even-odd').restore();
  doc.rect(40, 380, panel - 80, 0.75).fill(WHITE);
  doc.font('light').fontSize(9).fillColor(WHITE).text('CERTIFICATE NO.', 40, 398, { characterSpacing: 1.5 });
  doc.font('medium').fontSize(12).text(cert.code, 40, 412, { characterSpacing: 0.5 });

  const qr = await QRCode.toBuffer(verifyUrl(cert.code), { margin: 1, width: 240, color: { dark: INK, light: '#FFFFFF' } });
  doc.image(qr, 40, 452, { width: 92 });
  doc.font('light').fontSize(7.5).fillColor(WHITE).text('Scan to verify authenticity', 40, 550, { width: 140 });

  // Frame
  doc.lineWidth(1).rect(panel + 24, 24, W - panel - 48, H - 48).stroke(SOFT);

  const x = panel + 60;
  const w = W - panel - 120;
  doc.font('medium').fontSize(11).fillColor(MUTED).text('CERTIFICATE OF COMPLETION', x, 80, { width: w, characterSpacing: 3 });
  doc.font('light').fontSize(14).fillColor(INK).text('This certifies that', x, 140, { width: w });
  doc.font('regular').fontSize(fitSize(doc, cert.full_name, w, 38)).text(cert.full_name, x, 168, { width: w });
  doc.rect(x, 226, w, 1).fill(SOFT);
  doc.font('light').fontSize(14).fillColor(INK).text('has successfully completed the', x, 246, { width: w });
  doc.font('bold').fontSize(22).text(cert.course_title, x, 270, { width: w });
  doc
    .font('light')
    .fontSize(12)
    .fillColor(MUTED)
    .text(`and passed the final examination with a score of ${cert.score_percent}%.`, x, doc.y + 8, { width: w });

  const cols = [
    ['DATE ISSUED', fmt(cert.issued_at)],
    ['VALID UNTIL', cert.expires_at ? fmt(cert.expires_at) : 'No expiry'],
    ['ISSUED BY', 'The High Vault Security'],
  ];
  const colW = w / 3;
  cols.forEach(([label, value], i) => {
    doc.font('medium').fontSize(8).fillColor(MUTED).text(label, x + i * colW, 440, { width: colW - 10, characterSpacing: 1.5 });
    doc.font('regular').fontSize(12).fillColor(INK).text(value, x + i * colW, 456, { width: colW - 10 });
  });

  doc
    .font('light')
    .fontSize(8)
    .fillColor(MUTED)
    .text(`Verify this certificate at ${verifyUrl(cert.code)}`, x, 540, { width: w });

  doc.end();
}

function fitSize(doc, text, width, max) {
  let size = max;
  doc.font('regular');
  while (size > 18 && doc.fontSize(size).widthOfString(text) > width) size -= 1;
  return size;
}
