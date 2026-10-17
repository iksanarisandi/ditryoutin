export const CONTACT_SEGMENTS = {
  never_paid: 'belum-pernah-beli',
  expired: 'pernah-beli-nonaktif',
  active: 'akses-aktif',
  all: 'semua-pengguna',
} as const;

export type ContactSegment = keyof typeof CONTACT_SEGMENTS;
type Contact = { email: string; name: string };

export function isContactSegment(value: string): value is ContactSegment {
  return Object.hasOwn(CONTACT_SEGMENTS, value);
}

export async function exportContacts(
  db: D1Database,
  segment: ContactSegment,
  now: string,
  googleOnly = false,
): Promise<Contact[]> {
  // Status bayar berasal dari ledger, bukan akses yang bisa diberikan manual/referral.
  const paid = `EXISTS (SELECT 1 FROM payments p WHERE p.user_id=u.id AND p.status='paid')`;
  const inactive = `(u.access_expires_at IS NULL OR u.access_expires_at<=?1)`;
  const filters: Record<ContactSegment, string> = {
    never_paid: `${inactive} AND NOT ${paid}`,
    expired: `${inactive} AND ${paid}`,
    active: 'u.access_expires_at>?1',
    all: '1=1',
  };
  const query = db.prepare(
    `SELECT lower(trim(u.email)) AS email, u.name FROM users u
     WHERE u.role='user' AND lower(trim(u.email)) LIKE '%@gmail.com'
       AND ${filters[segment]}
       ${googleOnly ? 'AND u.google_sub IS NOT NULL' : ''}
     ORDER BY u.id ASC`,
  );
  const rows = await (segment === 'all' ? query : query.bind(now)).all<Contact>();
  const seen = new Set<string>();
  return (rows.results ?? []).filter((row) => {
    // Gmail saja, bukan googlemail/subdomain; abaikan alamat rusak sebelum impor.
    if (!/^[a-z0-9][a-z0-9.+_-]*@gmail\.com$/.test(row.email) || seen.has(row.email)) return false;
    seen.add(row.email);
    return true;
  });
}

function csvCell(value: string): string {
  // Nama berasal dari input user; quoting CSV saja tidak mencegah formula spreadsheet.
  const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function contactsCsv(contacts: Contact[]): string {
  const rows = contacts.map(({ email, name }) => {
    const [first = '', ...rest] = name.trim().split(/\s+/);
    return [email, first, rest.join(' ')].map(csvCell).join(',');
  });
  return ['EMAIL,FIRSTNAME,LASTNAME', ...rows].join('\r\n') + '\r\n';
}
