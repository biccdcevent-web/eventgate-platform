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

// Reads the pixel size of a PNG or JPEG, so the logo can be given an exact size.
// Desktop Outlook ignores max-width/max-height and would otherwise show the logo at full size.
function imageSize(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.slice(1, 4).toString() === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}
function fitBox(size, maxW, maxH) {
  if (!size || !size.w || !size.h) return { w: maxW, h: maxH };
  const k = Math.min(maxW / size.w, maxH / size.h, 1);
  return { w: Math.round(size.w * k), h: Math.round(size.h * k) };
}

// Builds the pass email. Images are referenced as cid:passqr, cid:eventlogo and cid:jupiterlogo.
// Layout: a fixed 600px card (with an Outlook fallback table), pixel line heights, Arial in Outlook,
// and print styles so it prints cleanly on A4 or Letter.
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
  const [logoW, logoH] = (EG.LOGO_SIZES[b.logoSize] || EG.LOGO_SIZES.medium).email;
  const logo = hasLogo ? fitBox(imageSize(logoPath), logoW, logoH) : null;
  const logoAlign = EG.LOGO_ALIGNS.includes(b.logoAlign) ? b.logoAlign : 'left';
  const logoMargin = { left: '0', center: '0 auto', right: '0 0 0 auto' }[logoAlign];
  const fields = new Map(c.form.fields.map((f) => [f.key, f]));
  const bg = b.background;
  const ink = '#141414', muted = '#5C5C5C';

  const row = (label, value) =>
    `<tr><td width="150" valign="top" style="${font}padding:9px 16px 9px 0;color:${muted};font-size:14px;line-height:20px;width:150px;border-bottom:1px solid #EEEEEE">${esc(label)}</td>` +
    `<td valign="top" style="${font}padding:9px 0;color:${ink};font-size:15px;line-height:21px;border-bottom:1px solid #EEEEEE">${esc(value)}</td></tr>`;
  const summary = [row('Name', vars.full_name)];
  for (const k of em.summaryFields) {
    const f = fields.get(k);
    if (f && f.enabled && values[k] && !['first_name', 'last_name'].includes(k)) summary.push(row(f.label, values[k]));
  }

  const subject = EG.fill(em.subject, vars).replace(/\s+/g, ' ').trim() || `Your pass for ${c.details.name}`;
  const body = EG.richText(EG.fill(em.body, vars), {
    p: `${font}margin:0 0 16px;font-size:16px;line-height:26px;color:${ink}`,
    ul: 'margin:0 0 16px;padding:0 0 0 22px',
    li: `${font}margin:0 0 8px;font-size:16px;line-height:24px;color:${ink}`,
  });
  const footer = EG.richText(EG.fill(em.footer, vars), {
    p: `${font}margin:0 0 8px;font-size:13px;line-height:20px;color:${muted}`,
    ul: 'margin:0 0 8px;padding:0 0 0 18px',
    li: `${font}font-size:13px;line-height:20px;color:${muted}`,
  });

  const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>body,table,td,p,div,span,a,li{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
<style>
  @media screen and (max-width: 640px) {
    .eg-card { width: 100% !important; }
    .eg-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .eg-outer { padding: 16px 8px !important; }
  }
  @media print {
    body, .eg-bg { background: #ffffff !important; }
    .eg-outer { padding: 0 !important; }
    .eg-card { width: 100% !important; max-width: 680px !important; border: 1px solid #D9D9D9 !important; }
    .eg-noprint { display: none !important; }
  }
</style>
</head>
<body class="eg-bg" style="margin:0;padding:0;background:${bg};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<table role="presentation" class="eg-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background:${bg}">
<tr><td class="eg-outer" align="center" style="padding:32px 12px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" class="eg-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background:#ffffff;border-top:6px solid ${b.primary}">
  <tr><td class="eg-pad" style="padding:32px 40px 8px;text-align:left">
    ${logo ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${logoAlign}" style="padding:0 0 20px"><img src="cid:eventlogo" width="${logo.w}" height="${logo.h}" alt="${esc(c.details.organizer || c.details.name)}" style="display:block;width:${logo.w}px;height:${logo.h}px;max-width:100%;border:0;outline:none;margin:${logoMargin}"></td></tr></table>` : ''}
    <h1 style="${hfont}margin:0;font-size:24px;line-height:31px;font-weight:bold;color:${ink}">${esc(c.details.name)}</h1>
    ${c.details.date ? `<p style="${font}margin:8px 0 0;font-size:15px;line-height:22px;color:${muted}">${esc(c.details.date)}</p>` : ''}
    ${c.details.venue ? `<p style="${font}margin:0;font-size:15px;line-height:22px;color:${muted}">${esc(c.details.venue)}</p>` : ''}
  </td></tr>
  <tr><td class="eg-pad" style="padding:24px 40px 8px;text-align:left">
    ${body}
  </td></tr>
  ${withQr ? `<tr><td align="center" style="padding:8px 40px 4px">
    <img src="cid:passqr" width="220" height="220" alt="Your QR pass" style="display:block;width:220px;height:220px;border:1px solid #D4D4D4;margin:0 auto">
  </td></tr>
  <tr><td align="center" style="padding:10px 40px 24px">
    <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:22px;line-height:28px;font-weight:bold;letter-spacing:3px;color:${ink}">${esc(passCode)}</p>
    <p style="${font}margin:4px 0 0;font-size:13px;line-height:18px;color:${muted}">Pass code</p>
  </td></tr>` : ''}
  <tr><td class="eg-pad" style="padding:8px 40px ${footer ? '8px' : '36px'}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E6E6E6">${summary.join('')}</table>
  </td></tr>
  ${footer ? `<tr><td class="eg-pad" style="padding:20px 40px 36px">${footer}</td></tr>` : ''}
</table>
<!--[if mso]></td></tr></table><![endif]-->
<table role="presentation" width="600" class="eg-card" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
  <tr><td align="center" style="padding:18px 20px 0">
    <p style="${font}margin:0;font-size:12px;line-height:18px;color:${muted}">Sent by ${esc(vars.organizer)} because you registered for ${esc(c.details.name)}.</p>
  </td></tr>
  <tr><td align="center" style="padding:10px 0 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
      <td style="${font}color:#8C8C8C;font-size:11px;line-height:14px;padding-right:6px;vertical-align:middle">Powered by</td>
      <td style="vertical-align:middle"><img src="cid:jupiterlogo" width="69" height="22" alt="Jupiter Systems, Inc." style="display:block;width:69px;height:22px;border:0"></td>
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

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
