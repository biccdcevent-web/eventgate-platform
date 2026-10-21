/* Shared by the server and the browser: event settings defaults, form field rules,
   simple text formatting and colour helpers. Keep it dependency-free. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ choices offered in the admin
  const FONTS = [
    'Roboto', 'Inter', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito Sans', 'Source Sans 3',
    'Raleway', 'Work Sans', 'Oswald', 'Merriweather', 'Lora', 'Playfair Display', 'Arial',
  ];
  const TEXT_SIZES = { small: 15, normal: 16, large: 18 };
  const TIMEZONES = [
    ['Asia/Manila', 'Philippines (Manila)'], ['Asia/Singapore', 'Singapore'], ['Asia/Hong_Kong', 'Hong Kong'],
    ['Asia/Tokyo', 'Japan (Tokyo)'], ['Asia/Seoul', 'Korea (Seoul)'], ['Asia/Bangkok', 'Thailand / Vietnam / Indonesia (west)'],
    ['Asia/Kolkata', 'India'], ['Asia/Dubai', 'UAE (Dubai)'], ['Australia/Sydney', 'Australia (Sydney)'],
    ['Europe/London', 'United Kingdom'], ['Europe/Paris', 'Central Europe'], ['America/New_York', 'US Eastern'],
    ['America/Los_Angeles', 'US Pacific'], ['UTC', 'UTC'],
  ];
  const FIELD_TYPES = {
    text: 'Short text',
    textarea: 'Long text',
    email: 'Email',
    phone_ph: 'Philippine mobile (+63)',
    phone: 'Phone (any country)',
    address_ph: 'Philippine address (region to barangay)',
    number: 'Number',
    select: 'Dropdown (choose one)',
    radio: 'Options (choose one)',
    yesno: 'Yes / No question',
    checkbox: 'Tick box (tick to confirm)',
    date: 'Date',
  };
  // Built-in fields are stored in their own columns. First name, last name and email are always on the form.
  const BUILTIN = ['first_name', 'last_name', 'email', 'designation', 'company_name', 'company_address', 'contact_number'];
  // Always on the form and required. Email is too, unless the event sends no QR pass (see emailRules).
  const LOCKED = ['first_name', 'last_name'];
  // Address parts, in the order used in reports, exports and the written-out address.
  const ADDRESS_PARTS = [
    ['street', 'Unit, floor, building and street'], ['barangay', 'Barangay'], ['city', 'City / Municipality'],
    ['province', 'Province'], ['region', 'Region'], ['zip', 'Postal code'],
  ];
  const composeAddress = (p) => ADDRESS_PARTS.map(([k]) => (p && p[k]) || '').filter(Boolean).join(', ');
  const shortAddress = (p) => (p ? [p.city, p.province].filter(Boolean).join(', ') : '');
  // ------------------------------------------------------------ event date and time
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  // Times offered in the start and end time lists: every 15 minutes.
  const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
  function timeLabel(t) {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const dayParts = (v) => { const d = new Date(`${v}T00:00:00Z`); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay() }; };
  // "Thursday, 26 November 2026, 8:00 AM – 5:00 PM" or "Thu–Sat, 26–28 November 2026, 8:00 AM – 5:00 PM"
  function formatSchedule(s) {
    if (!s || !isDate(s.start)) return '';
    const a = dayParts(s.start);
    let date;
    if (s.days === 'multi' && isDate(s.end) && s.end > s.start) {
      const b = dayParts(s.end);
      const span = a.y !== b.y ? `${a.d} ${MONTHS[a.m]} ${a.y} – ${b.d} ${MONTHS[b.m]} ${b.y}`
        : a.m !== b.m ? `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]} ${b.y}` : `${a.d}–${b.d} ${MONTHS[a.m]} ${a.y}`;
      date = `${WEEKDAYS[a.w].slice(0, 3)}–${WEEKDAYS[b.w].slice(0, 3)}, ${span}`;
    } else date = `${WEEKDAYS[a.w]}, ${a.d} ${MONTHS[a.m]} ${a.y}`;
    const time = s.from ? (s.to ? `${timeLabel(s.from)} – ${timeLabel(s.to)}` : timeLabel(s.from)) : '';
    return time ? `${date}, ${time}` : date;
  }
  function sanitizeSchedule(v) {
    const o = v && typeof v === 'object' ? v : {};
    const out = { days: o.days === 'multi' ? 'multi' : 'one', start: isDate(o.start) ? o.start : '', end: '', from: TIMES.includes(o.from) ? o.from : '', to: '' };
    if (out.days === 'multi' && out.start && isDate(o.end) && o.end > out.start) out.end = o.end;
    if (out.from && TIMES.includes(o.to) && o.to > out.from) out.to = o.to;
    return out;
  }
  // Problems to show next to the date and time settings ('' when fine).
  function scheduleProblem(s) {
    if (!s) return '';
    if (s.days === 'multi' && s.start && (!s.end || s.end <= s.start)) return 'Choose an end date after the start date.';
    if (s.to && !s.from) return 'Choose a start time too.';
    if (s.from && s.to && s.to <= s.from) return 'The end time must be later than the start time.';
    return '';
  }

  // Logo size in each place: page [max height, max width] in px, email [max width, max height] in px,
  // tag [max height as a share of the label height, max width as a share of the label width].
  const LOGO_SIZES = {
    small: { page: [52, 200], email: [150, 40], tag: [0.10, 0.45] },
    medium: { page: [76, 280], email: [200, 56], tag: [0.14, 0.60] },
    large: { page: [110, 380], email: [260, 76], tag: [0.20, 0.80] },
  };
  const LOGO_ALIGNS = ['left', 'center', 'right'];
  // Where the logo sits relative to the event name: above it (then aligned left, centre or right), or beside it.
  const LOGO_PLACES = ['above', 'left', 'right'];

  const PLACEHOLDERS = ['first_name', 'last_name', 'full_name', 'event_name', 'event_date', 'venue', 'organizer', 'pass_code'];

  const DPA_TEXT = [
    'In compliance with the Data Privacy Act (DPA) of 2012 and its implementing rules, we respect your right to privacy and are committed to protecting the personal data you provide through this form.',
    '',
    '- **Collection & Purpose:** The personal information you provide (such as your name, contact details, and affiliation) will be collected, stored, and processed solely for the purpose of event registration, verification, coordination, issuance of certificates and sending relevant updates regarding the event.',
    '- **Sharing & Disclosure:** Your information will not be sold, shared, or disclosed to third parties, except as necessary for event logistics or when required by law.',
    '- **Security & Retention:** We implement reasonable and appropriate physical, technical, and organizational security measures to protect your data. Your information will be retained only for as long as necessary to fulfill the purposes stated above or as required by applicable guidelines.',
    '- **Rights of the Data Subject:** You have the right to be informed, to object, to access, to rectify, and to erase or block your personal data under the DPA.',
  ].join('\n');

  // Standard email wording for each way of checking in: with a QR pass, by name at the desk, or no check-in.
  const EMAIL_TEXT = {
    qr: {
      subject: 'Your pass for {event_name}',
      body: "Hi {first_name},\n\nYou're registered. The QR code below is your pass. Show it at the registration desk when you arrive, either on your phone or printed.",
      footer: "This pass admits one person. Please don't post it publicly. If the code won't scan, staff can type in the pass code shown above.",
    },
    name: {
      subject: "You're registered for {event_name}",
      body: "Hi {first_name},\n\nYou're registered for {event_name}. When you arrive, just give your name at the registration desk.",
      footer: '',
    },
    none: {
      subject: "You're registered for {event_name}",
      body: "Hi {first_name},\n\nThank you for registering for {event_name}. We look forward to seeing you.",
      footer: '',
    },
  };
  const emailMode = (c) => (!c.checkin || c.checkin.enabled ? (!c.checkin || c.checkin.qr ? 'qr' : 'name') : 'none');
  // The event's email texts, with standard wording swapped to match how the event checks people in.
  function effectiveEmail(c) {
    const mode = emailMode(c);
    const e = { ...c.email };
    for (const k of ['subject', 'body', 'footer']) {
      for (const m of Object.keys(EMAIL_TEXT)) if (m !== mode && e[k] && e[k] === EMAIL_TEXT[m][k]) e[k] = EMAIL_TEXT[mode][k];
    }
    return e;
  }

  function defaultFields() {
    return [
      { key: 'first_name', type: 'text', label: 'First name', required: true, enabled: true, width: 'half', placeholder: '', help: '' },
      { key: 'last_name', type: 'text', label: 'Last name', required: true, enabled: true, width: 'half', placeholder: '', help: '' },
      { key: 'designation', type: 'text', label: 'Designation', required: true, enabled: true, width: 'half', placeholder: 'e.g. Operations Manager', help: '' },
      { key: 'company_name', type: 'text', label: 'Company name', required: true, enabled: true, width: 'half', placeholder: '', help: '' },
      { key: 'company_address', type: 'address_ph', label: 'Company address', required: true, enabled: true, width: 'full', placeholder: '', help: '' },
      { key: 'contact_number', type: 'phone_ph', label: 'Contact number', required: true, enabled: true, width: 'half', placeholder: '9171234567', help: '8 to 10 digits, without the leading 0' },
      { key: 'email', type: 'email', label: 'Email', required: true, enabled: true, width: 'half', placeholder: 'Your pass is sent here', help: '' },
    ];
  }

  function defaultConfig(d = {}) {
    return {
      details: {
        name: d.name || 'New event',
        date: d.date || '',
        schedule: { days: 'one', start: '', end: '', from: '', to: '' },
        venue: d.venue || '',
        organizer: d.organizer || '',
        intro: "Register below and we'll email you a QR code. That code is your pass: show it at the registration desk when you arrive.",
        timezone: d.timezone || 'Asia/Manila',
        capacity: null,
      },
      branding: {
        logo: null,
        primary: '#E00000',
        secondary: '#141414',
        background: '#F2F2F2',
        headingFont: 'Roboto',
        bodyFont: 'Roboto',
        textSize: 'normal',
        logoOnTag: true,
        logoInEmail: true,
        logoAlign: 'left',
        logoSize: 'medium',
        emailLogoAlign: 'left',
        emailLogoSize: 'medium',
        tagLogoAlign: 'center',
        tagLogoSize: 'medium',
        logoPlace: 'above',
        emailLogoPlace: 'above',
        tagLogoPlace: 'above',
      },
      form: {
        fields: defaultFields(),
        consent: {
          enabled: true,
          title: 'Data Privacy Consent Statement',
          body: DPA_TEXT,
          checkbox: 'I have read, understood, and agree to the collection, processing, and use of my personal data as described above for the purpose of registering for this event.',
        },
        submitLabel: 'Register and email my pass',
        allowAnother: true,
        successTitle: "You're registered",
        closedMessage: 'Registration for this event is closed.',
      },
      email: {
        send: true,
        fromName: '',
        replyTo: '',
        subject: EMAIL_TEXT.qr.subject,
        body: EMAIL_TEXT.qr.body,
        summaryFields: ['designation', 'company_name'],
        footer: EMAIL_TEXT.qr.footer,
      },
      badge: { line2: 'designation', line3: 'company_name', showEventName: true },
      // On-site check-in. Without a QR pass, staff find attendees by name; name tags need check-in.
      checkin: { enabled: true, qr: true, nameTags: true },
    };
  }

  // ------------------------------------------------------------ settings clean-up (server trusts only this)
  const str = (v, max, fallback = '') => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : fallback);
  const line = (v, max, fallback = '') => str(v, max, fallback).replace(/\s+/g, ' ').trim();
  const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

  function sanitizeField(f, i) {
    const key = BUILTIN.includes(f.key) ? f.key : (/^c_[a-z0-9_]{1,40}$/.test(f.key) ? f.key : `c_field${i + 1}`);
    let type = FIELD_TYPES[f.type] ? f.type : 'text';
    if (key === 'email') type = 'email';
    else if (type === 'email') type = 'text'; // only one email field: the one passes are sent to
    const out = {
      key, type,
      label: line(f.label, 80) || 'Untitled field',
      required: LOCKED.includes(key) ? true : bool(f.required, false),
      enabled: LOCKED.includes(key) ? true : bool(f.enabled, true),
      width: f.width === 'full' || ['address_ph', 'textarea', 'radio', 'checkbox'].includes(type) ? 'full' : 'half',
      placeholder: line(f.placeholder, 80),
      help: line(f.help, 160),
    };
    if (type === 'select' || type === 'radio') {
      const opts = (Array.isArray(f.options) ? f.options : []).map((o) => line(o, 80)).filter(Boolean);
      out.options = [...new Set(opts)].slice(0, 50);
      if (!out.options.length) out.options = ['Option 1', 'Option 2'];
    }
    return out;
  }

  function sanitizeConfig(input, base) {
    const c = input && typeof input === 'object' ? input : {};
    const b = base || defaultConfig();
    const d = c.details || {}, br = c.branding || {}, fm = c.form || {}, em = c.email || {}, bg = c.badge || {};
    const cap = Number(d.capacity);
    const schedule = sanitizeSchedule(d.schedule);
    const out = {
      details: {
        name: line(d.name, 120) || b.details.name,
        // Shown everywhere (page, email, name tag). Built from the date and time pickers; older events keep their typed text.
        date: schedule.start ? formatSchedule(schedule) : line(d.date, 120),
        schedule,
        venue: line(d.venue, 160),
        organizer: line(d.organizer, 120),
        intro: str(d.intro, 2000).trim(),
        timezone: TIMEZONES.some(([z]) => z === d.timezone) ? d.timezone : 'Asia/Manila',
        capacity: Number.isInteger(cap) && cap > 0 ? Math.min(cap, 100000) : null,
      },
      branding: {
        logo: typeof br.logo === 'string' && /^\/uploads\/[A-Za-z0-9._-]+$/.test(br.logo) ? br.logo : null,
        primary: isHex(br.primary) ? br.primary.toUpperCase() : b.branding.primary,
        secondary: isHex(br.secondary) ? br.secondary.toUpperCase() : b.branding.secondary,
        background: isHex(br.background) ? br.background.toUpperCase() : b.branding.background,
        headingFont: FONTS.includes(br.headingFont) ? br.headingFont : 'Roboto',
        bodyFont: FONTS.includes(br.bodyFont) ? br.bodyFont : 'Roboto',
        textSize: TEXT_SIZES[br.textSize] ? br.textSize : 'normal',
        logoOnTag: bool(br.logoOnTag, true),
        logoInEmail: bool(br.logoInEmail, true),
        // Position and size of the logo on the registration page, in the email and on the name tag.
        logoAlign: LOGO_ALIGNS.includes(br.logoAlign) ? br.logoAlign : 'left',
        logoSize: LOGO_SIZES[br.logoSize] ? br.logoSize : 'medium',
        emailLogoAlign: LOGO_ALIGNS.includes(br.emailLogoAlign) ? br.emailLogoAlign : 'left',
        emailLogoSize: LOGO_SIZES[br.emailLogoSize] ? br.emailLogoSize : 'medium',
        tagLogoAlign: LOGO_ALIGNS.includes(br.tagLogoAlign) ? br.tagLogoAlign : 'center',
        tagLogoSize: LOGO_SIZES[br.tagLogoSize] ? br.tagLogoSize : 'medium',
        logoPlace: LOGO_PLACES.includes(br.logoPlace) ? br.logoPlace : 'above',
        emailLogoPlace: LOGO_PLACES.includes(br.emailLogoPlace) ? br.emailLogoPlace : 'above',
        tagLogoPlace: LOGO_PLACES.includes(br.tagLogoPlace) ? br.tagLogoPlace : 'above',
      },
      form: {
        fields: [],
        consent: {
          enabled: bool((fm.consent || {}).enabled, true),
          title: line((fm.consent || {}).title, 120),
          body: str((fm.consent || {}).body, 6000).trim(),
          checkbox: line((fm.consent || {}).checkbox, 400) || 'I agree to the processing of my personal data for this event.',
        },
        submitLabel: line(fm.submitLabel, 60) || 'Register',
        allowAnother: bool(fm.allowAnother, true),
        successTitle: line(fm.successTitle, 80) || "You're registered",
        closedMessage: line(fm.closedMessage, 300) || 'Registration for this event is closed.',
      },
      email: {
        send: bool(em.send, true),
        fromName: line(em.fromName, 80),
        replyTo: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(line(em.replyTo, 254)) ? line(em.replyTo, 254) : '',
        subject: line(em.subject, 150) || 'Your pass for {event_name}',
        body: str(em.body, 4000).trim(),
        summaryFields: [],
        footer: str(em.footer, 1000).trim(),
      },
      badge: { line2: '', line3: '', showEventName: bool(bg.showEventName, true) },
      checkin: { enabled: bool((c.checkin || {}).enabled, true), qr: bool((c.checkin || {}).qr, true), nameTags: bool((c.checkin || {}).nameTags, true) },
    };
    // fields: keep built-ins exactly once, keys unique, at most 40 fields
    const seen = new Set();
    for (const [i, f] of (Array.isArray(fm.fields) ? fm.fields : []).entries()) {
      if (!f || typeof f !== 'object') continue;
      const s = sanitizeField(f, i);
      if (BUILTIN.includes(s.key)) {
        if (seen.has(s.key)) continue;
      } else {
        let k = s.key, n = 2;
        while (seen.has(k)) k = `${s.key}_${n++}`;
        s.key = k;
      }
      seen.add(s.key);
      out.form.fields.push(s);
      if (out.form.fields.length >= 40) break;
    }
    for (const f of defaultFields()) {
      if (!seen.has(f.key)) out.form.fields.push({ ...f, enabled: LOCKED.includes(f.key) || f.key === 'email' });
    }
    const keys = new Set(out.form.fields.map((f) => f.key));
    out.email.summaryFields = (Array.isArray(em.summaryFields) ? em.summaryFields : []).filter((k) => keys.has(k)).slice(0, 10);
    out.badge.line2 = keys.has(bg.line2) ? bg.line2 : '';
    out.badge.line3 = keys.has(bg.line3) ? bg.line3 : '';
    if (!out.checkin.enabled) { out.checkin.qr = false; out.checkin.nameTags = false; }
    if (out.checkin.qr) out.email.send = true; // the QR pass is delivered by email
    const ef = out.form.fields.find((f) => f.key === 'email');
    const rule = emailRules(out);
    if (rule.enabledLocked) ef.enabled = true;
    if (rule.requiredLocked) ef.required = true;
    if (!ef.enabled) ef.required = false;
    return out;
  }

  // What the administrator may change on the Email field:
  // with a QR pass it is required; when a confirmation email is sent it stays on the form (optional allowed);
  // with no email at all it can be optional or hidden.
  function emailRules(c) {
    const qr = Boolean(c.checkin && c.checkin.qr);
    const send = qr || !c.email || c.email.send !== false;
    return { requiredLocked: qr, enabledLocked: send };
  }

  // ------------------------------------------------------------ registration values
  const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
  // Common slips in popular addresses.
  const DOMAIN_TYPOS = {
    'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com',
    'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com', 'gmail.comm': 'gmail.com',
    'yahoo.con': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhoo.com': 'yahoo.com',
    'hotmail.con': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com',
    'outlook.con': 'outlook.com', 'outlok.com': 'outlook.com', 'icloud.con': 'icloud.com', 'ymail.con': 'ymail.com',
  };
  // '' when the address is fine, otherwise a message saying what to fix.
  function emailProblem(v) {
    if (v.includes(',')) return 'Use a period (.) instead of a comma in the email address.';
    if (/\s/.test(v)) return 'Remove the spaces from the email address.';
    const at = (v.match(/@/g) || []).length;
    if (at === 0) return 'The email address is missing the @, like name@company.com.';
    if (at > 1) return 'Enter only one email address.';
    if (v.includes('..')) return 'The email address has two periods in a row.';
    const domain = v.split('@')[1];
    if (!domain.includes('.')) return 'The part after the @ is incomplete, like company.com.';
    if (DOMAIN_TYPOS[domain]) return `Check the email address. Did you mean ${v.split('@')[0]}@${DOMAIN_TYPOS[domain]}?`;
    if (/\.(con|cmo|ocm|comm)$/.test(domain)) return 'Check the ending of the email address. Did you mean .com?';
    if (v.length > 254 || !EMAIL_RE.test(v)) return 'Enter a valid email address, like name@company.com.';
    return '';
  }
  const LIMITS = { text: 150, textarea: 500, phone: 20, number: 20, date: 10 };

  // Cleans one submitted value. Returns { value, error }.
  function checkField(f, raw) {
    let v = raw;
    if (f.type === 'address_ph') {
      const o = raw && typeof raw === 'object' ? raw : {};
      const parts = {};
      for (const [k] of ADDRESS_PARTS) parts[k] = typeof o[k] === 'string' ? o[k].replace(/\s+/g, ' ').trim().slice(0, k === 'street' ? 200 : 120) : '';
      const any = ADDRESS_PARTS.some(([k]) => parts[k]);
      if (!any) return f.required ? { value: '', error: 'Enter the address.' } : { value: '' };
      if (f.required && parts.street.length < 2) return { value: '', error: 'Enter the unit, floor, building and street.' };
      for (const [k, msg] of [['region', 'Choose a region.'], ['province', 'Choose a province.'], ['city', 'Choose a city or municipality.'], ['barangay', 'Choose a barangay.']]) {
        if (!parts[k]) return { value: '', error: msg };
      }
      if (!/^\d{4}$/.test(parts.zip)) return { value: '', error: 'Enter or choose the 4-digit postal code.' };
      return { value: composeAddress(parts), parts };
    }
    if (f.type === 'yesno') {
      v = typeof raw === 'string' ? raw.trim() : '';
      if (v !== 'Yes' && v !== 'No') return f.required ? { value: '', error: 'Choose Yes or No.' } : { value: '' };
      return { value: v };
    }
    if (f.type === 'checkbox') {
      v = raw === true || raw === 'true' || raw === 'on' || raw === 'Yes';
      if (f.required && !v) return { value: '', error: 'Tick this box to continue.' };
      return { value: v ? 'Yes' : 'No' };
    }
    v = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
    v = f.type === 'textarea' ? v.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim() : v.replace(/\s+/g, ' ').trim();
    if (!v) return f.required ? { value: '', error: 'This field is required.' } : { value: '' };
    switch (f.type) {
      case 'email':
        v = v.toLowerCase();
        { const problem = emailProblem(v); if (problem) return { value: v, error: problem }; }
        return { value: v };
      case 'phone_ph': {
        const d = v.replace(/[\s()-]/g, '').replace(/^\+?63(?=\d{9,10}$)/, '').replace(/^0+/, '');
        if (!/^\d+$/.test(d)) return { value: v, error: 'Enter numbers only.' };
        if (d.length < 8 || d.length > 10) return { value: v, error: 'Enter 8 to 10 digits after +63.' };
        if (d.length === 10 && d[0] !== '9') return { value: v, error: 'Mobile numbers start with 9, like 917 123 4567.' };
        return { value: `+63 ${d}` };
      }
      case 'phone':
        if (/[^\d\s()+-]/.test(v)) return { value: v, error: 'Use numbers only (you may start with +).' };
        if (!/^\+?[\d\s()-]{6,20}$/.test(v) || v.replace(/\D/g, '').length < 7) return { value: v, error: 'Enter a valid phone number, including the area or country code.' };
        return { value: v };
      case 'number':
        if (!/^-?\d+(\.\d+)?$/.test(v)) return { value: v, error: 'Enter a number.' };
        return { value: v };
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { value: v, error: 'Enter a date.' };
        return { value: v };
      case 'select': case 'radio':
        if (!(f.options || []).includes(v)) return { value: v, error: 'Choose one of the options.' };
        return { value: v };
      default: {
        const max = LIMITS[f.type] || 150;
        if (v.length > max) return { value: v, error: `Keep this under ${max} characters.` };
        if (f.key === 'company_address' && v.length < 5) return { value: v, error: 'Enter at least 5 characters.' };
        return { value: v };
      }
    }
  }

  function checkSubmission(config, body) {
    const values = {}, errors = {};
    for (const f of config.form.fields) {
      if (!f.enabled) continue;
      const r = checkField(f, body ? body[f.key] : undefined);
      values[f.key] = r.value;
      if (r.parts) values[`${f.key}__parts`] = r.parts;
      if (r.error) errors[f.key] = r.error;
    }
    if (config.form.consent.enabled && (!body || body.consent !== true)) errors.consent = 'Tick this box to register.';
    return { values, errors };
  }

  // ------------------------------------------------------------ text helpers
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Paragraphs separated by blank lines, "- " bullet lists, **bold**. Everything else is plain text.
  function richText(src, style = {}) {
    const p = style.p ? ` style="${style.p}"` : '', ul = style.ul ? ` style="${style.ul}"` : '', li = style.li ? ` style="${style.li}"` : '';
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    return String(src || '').split(/\n\s*\n/).map((block) => {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) return '';
      if (lines.every((l) => /^\s*[-•]\s+/.test(l))) return `<ul${ul}>${lines.map((l) => `<li${li}>${inline(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('')}</ul>`;
      return `<p${p}>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }

  function fill(template, vars) {
    return String(template || '').replace(/\{([a-z0-9_]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] ?? '') : m));
  }

  // ------------------------------------------------------------ colours
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const textOn = (hex) => (contrast(hex, '#FFFFFF') >= contrast(hex, '#141414') ? '#FFFFFF' : '#141414');

  function fontStack(name) {
    if (name === 'Arial') return 'Arial, "Helvetica Neue", Helvetica, sans-serif';
    const serif = ['Merriweather', 'Lora', 'Playfair Display'].includes(name);
    return `"${name}", ${serif ? 'Georgia, "Times New Roman", serif' : '"Helvetica Neue", Arial, sans-serif'}`;
  }
  function googleFontsUrl(names) {
    const fams = [...new Set(names)].filter((n) => n && n !== 'Arial');
    if (!fams.length) return '';
    return `https://fonts.googleapis.com/css2?${fams.map((n) => `family=${n.replace(/ /g, '+')}:wght@400;700`).join('&')}&display=swap`;
  }

  return {
    MONTHS, WEEKDAYS, TIMES, timeLabel, formatSchedule, sanitizeSchedule, scheduleProblem, isDate, LOGO_SIZES, LOGO_ALIGNS, LOGO_PLACES, emailRules, emailProblem,
    FONTS, TEXT_SIZES, TIMEZONES, FIELD_TYPES, BUILTIN, LOCKED, PLACEHOLDERS, DPA_TEXT, ADDRESS_PARTS, composeAddress, shortAddress, EMAIL_TEXT, emailMode, effectiveEmail,
    defaultFields, defaultConfig, sanitizeConfig, checkField, checkSubmission,
    esc, richText, fill, luminance, contrast, textOn, fontStack, googleFontsUrl,
  };
});
