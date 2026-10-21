'use strict';
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const EG = require('./lib/shared');

let transporter = null;
let devMode = false;

function getTransport() {
  if (transporter) return transporter;
  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      pool: true,            // reuse a few connections instead of reconnecting for every pass
      maxConnections: 3,
      maxMessages: 100,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } else {
    // No SMTP configured: build the full email and save it to ./outbox for inspection.
    devMode = true;
    transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    console.warn('[mail] SMTP_HOST is not set. Emails will be saved to ./outbox instead of being sent.');
  }
  return transporter;
}

// The sending address always comes from MAIL_FROM (it must be on the verified domain);
// each event can show its own sender name and reply-to address.
function senderAddress() {
  const raw = String(process.env.MAIL_FROM || '');
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : 'no-reply@example.com';
}

const esc = EG.esc;

function templateVars(event, values, passCode) {
  const d = event.config.details;
  return {
    ...values,
    full_name: `${values.first_name || ''} ${values.last_name || ''}`.trim(),
    event_name: d.name, event_date: d.date, venue: d.venue, organizer: d.organizer || d.name,
    pass_code: passCode,
  };
}

// Builds the pass email. Images are referenced as cid:passqr, cid:eventlogo and cid:jupiterlogo.
function renderPassEmail({ event, values, passCode, uploadsDir }) {
  const c = event.config;
  const b = c.branding;
  const vars = templateVars(event, values, passCode);
  const em = EG.effectiveEmail(c);
  const withQr = EG.emailMode(c) === 'qr';   // no QR code or pass code when the event doesn't use them
  const font = `font-family:${EG.fontStack(b.bodyFont).replace(/"/g, "'")};`;
  const hfont = `font-family:${EG.fontStack(b.headingFont).replace(/"/g, "'")};`;
  const logoPath = b.logoInEmail && b.logo ? path.join(uploadsDir, path.basename(b.logo)) : null;
  const hasLogo = Boolean(logoPath && fs.existsSync(logoPath));
  const fields = new Map(c.form.fields.map((f) => [f.key, f]));

  const row = (label, value) =>
    `<tr><td style="${font}padding:6px 12px 6px 0;color:#5C5C5C;font-size:13px;width:120px;vertical-align:top">${esc(label)}</td>` +
    `<td style="${font}padding:6px 0;color:#141414;font-size:14px">${esc(value)}</td></tr>`;
  const summary = [row('Name', vars.full_name)];
  for (const k of em.summaryFields) {
    const f = fields.get(k);
    if (f && f.enabled && values[k] && !['first_name', 'last_name'].includes(k)) summary.push(row(f.label, values[k]));
  }

  const subject = EG.fill(em.subject, vars).replace(/\s+/g, ' ').trim() || `Your pass for ${c.details.name}`;
  const body = EG.richText(EG.fill(em.body, vars), { p: 'margin:0 0 14px', ul: 'margin:0 0 14px;padding-left:20px', li: 'margin:0 0 6px' });
  const footer = EG.richText(EG.fill(em.footer, vars), { p: 'margin:0 0 8px', ul: 'margin:0 0 8px;padding-left:18px' });

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:${b.background};padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border-top:6px solid ${b.primary}">
  <tr><td style="${font}padding:26px 30px 6px;color:#141414">
    ${hasLogo ? `<img src="cid:eventlogo" alt="${esc(c.details.organizer || c.details.name)}" style="display:block;max-height:60px;max-width:220px;height:auto;width:auto;margin:0 0 18px;border:0">` : ''}
    <div style="${hfont}font-size:22px;font-weight:bold;line-height:1.25;color:#141414">${esc(c.details.name)}</div>
    ${c.details.date ? `<div style="${font}font-size:14px;margin-top:6px;color:#5C5C5C">${esc(c.details.date)}</div>` : ''}
    ${c.details.venue ? `<div style="${font}font-size:14px;color:#5C5C5C">${esc(c.details.venue)}</div>` : ''}
  </td></tr>
  <tr><td style="${font}padding:20px 30px 30px;color:#141414;font-size:15px;line-height:1.55">
    ${body}
    ${withQr ? `<div style="text-align:center;margin:10px 0 8px">
      <img src="cid:passqr" width="240" height="240" alt="Your QR pass" style="display:inline-block;border:1px solid #D4D4D4;border-radius:10px">
    </div>
    <div style="text-align:center;font-family:'Courier New',monospace;font-size:20px;font-weight:bold;letter-spacing:3px;margin:0 0 22px;color:#141414">${esc(passCode)}</div>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E6E6E6;padding-top:8px">${summary.join('')}</table>
    ${footer ? `<div style="${font}margin:22px 0 0;color:#5C5C5C;font-size:13px;line-height:1.5">${footer}</div>` : ''}
  </td></tr>
</table>
<p style="${font}text-align:center;color:#5C5C5C;font-size:12px;margin:16px 0 0">Sent by ${esc(vars.organizer)} because you registered for ${esc(c.details.name)}.</p>
<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:12px auto 0"><tr>
  <td style="${font}color:#8C8C8C;font-size:11px;padding-right:6px;vertical-align:middle">Powered by</td>
  <td style="vertical-align:middle"><img src="cid:jupiterlogo" width="69" height="22" alt="Jupiter Systems, Inc." style="display:block;border:0"></td>
</tr></table>
</body></html>`;

  const plain = (s) => String(s || '').replace(/\*\*(.+?)\*\*/g, '$1');
  const text = [
    plain(EG.fill(em.body, vars)),
    '',
    `${c.details.name}`,
    c.details.date ? `When: ${c.details.date}` : null,
    c.details.venue ? `Where: ${c.details.venue}` : null,
    '',
    withQr ? `Your pass code: ${passCode}` : null,
    withQr ? 'Your QR pass is attached. Show it at the registration desk when you arrive.' : null,
    withQr ? '' : null,
    `Name: ${vars.full_name}`,
    ...em.summaryFields.filter((k) => fields.get(k) && fields.get(k).enabled && values[k] && !['first_name', 'last_name'].includes(k)).map((k) => `${fields.get(k).label}: ${values[k]}`),
    '',
    plain(EG.fill(em.footer, vars)) || null,
    '',
    'Powered by Jupiter Systems, Inc.',
  ].filter((l) => l !== null).join('\n');

  return { subject, html, text, logoPath: hasLogo ? logoPath : null, withQr };
}

async function sendPassEmail({ event, values, passCode, qrPng, uploadsDir, to }) {
  const msg = renderPassEmail({ event, values, passCode, uploadsDir });
  const c = event.config;
  const attachments = [
    ...(msg.withQr ? [{ filename: `pass-${passCode}.png`, content: qrPng, contentType: 'image/png', cid: 'passqr' }] : []),
    { filename: 'jupiter-systems.png', path: path.join(__dirname, 'jupiter-logo-email.png'), contentType: 'image/png', cid: 'jupiterlogo' },
  ];
  if (msg.logoPath) attachments.push({ filename: `logo${path.extname(msg.logoPath)}`, path: msg.logoPath, cid: 'eventlogo' });
  const info = await getTransport().sendMail({
    from: { name: c.email.fromName || c.details.name, address: senderAddress() },
    replyTo: c.email.replyTo || undefined,
    to: to || values.email,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments,
  });

  if (devMode) {
    const dir = path.join(__dirname, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${event.slug}-${passCode.replace(/[^\w-]/g, '')}.eml`);
    fs.writeFileSync(file, info.message);
    console.log(`[mail] Saved email for ${to || values.email} to ${path.relative(process.cwd(), file)}`);
  }
  return info;
}

module.exports = { sendPassEmail, renderPassEmail, senderAddress };
