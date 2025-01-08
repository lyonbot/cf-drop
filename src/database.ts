export async function migrateTables(db: D1Database) {
  await db.exec(
    `
    CREATE TABLE IF NOT EXISTS upload_record (
      id INTEGER PRIMARY KEY,
      uploader TEXT NOT NULL,
      ctime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      size INTEGER DEFAULT 0,
      files TEXT DEFAULT '',
      message TEXT DEFAULT ''
    )
  `.replace(/\n/g, "")
  );
}

export interface UploadRecord {
  id: number;
  uploader: string;
  ctime: number;
  size: number;
  files: RecordFileItem[];
  message: string;
}

export interface RecordFileItem {
  name: string;
  size: number;
  path: string;
  thumbnail?: string;
}

function fromDB(data: any): UploadRecord {
  let files: RecordFileItem[] = [];
  try {
    files = JSON.parse(data.files);
  } catch {}

  return {
    id: data.id,
    uploader: data.uploader,
    ctime: +new Date(data.ctime),
    size: data.size,
    files,
    message: data.message,
  };
}

function toDB(record: UploadRecord) {
  return {
    id: record.id,
    uploader: record.uploader,
    ctime: new Date(+record.ctime),
    size: record.size,
    files: JSON.stringify(
      Array.from(
        record.files || [],
        (item) =>
          item && {
            name: String(item.name),
            size: +item.size,
            path: String(item.path || ""),
            thumbnail: String(item.thumbnail || ""),
          }
      ).filter(Boolean)
    ),
    message: record.message,
  };
}

/**
 * get latest 20 records. in descending order (newest first)
 *
 * to fetch older records, pass `beforeId` option (which is last id of prev page)
 */
export async function getUploadRecords(
  db: D1Database,
  opts: { beforeId?: number } = {}
) {
  const records: UploadRecord[] = [];

  let sql = "SELECT * FROM upload_record";
  if (opts.beforeId && Number.isInteger(opts.beforeId)) {
    sql += ` WHERE id < ${opts.beforeId}`;
  }
  sql += " ORDER BY id DESC LIMIT 20";

  const rows = await db.prepare(sql).all();
  for (const row of rows.results as any[]) {
    records.push(fromDB(row));
  }
  return records;
}

export async function getSingleUploadRecord(db: D1Database, id: number) {
  const record = await db
    .prepare(`SELECT * FROM upload_record WHERE id = ?`)
    .bind(id)
    .first<UploadRecord>();
  if (!record) return null;
  return fromDB(record);
}

export async function createUploadRecord(
  db: D1Database,
  record: Omit<UploadRecord, "id" | "ctime">
) {
  const inserting = toDB(record as UploadRecord);
  const res = await db
    .prepare(
      "INSERT INTO upload_record (uploader, size, files, message) VALUES (?, ?, ?, ?)"
    )
    .bind(
      inserting.uploader,
      inserting.size,
      inserting.files,
      inserting.message
    )
    .run();
  const id = res.meta.last_row_id;
  const inserted: UploadRecord = {
    ...(record as UploadRecord),
    ctime: +new Date(),
    id,
  };
  return { id, inserted };
}

export async function purgeRecordsBeforeId(
  db: D1Database,
  beforeId: number,
  deleteFiles: (path: string[]) => Promise<void>
) {
  // 1. fetch all ids and file
  const rows = await db
    .prepare("SELECT id, files FROM upload_record WHERE id < ?")
    .bind(beforeId)
    .all<UploadRecord>();
  const ids = rows.results.map((row) => row.id);

  // 2. delete files
  for (const row of rows.results) {
    const files = fromDB(row).files;
    if (!files.length) continue;
    await deleteFiles(files.map((file) => file.path));
  }

  // 3. delete records
  await db.prepare(`DELETE FROM upload_record WHERE id IN (${ids})`).run();

  return;
}

export async function deleteRecord(
  db: D1Database,
  id: number,
  deleteFiles: (path: string[]) => Promise<void>
) {
  // 1. get record
  const record = await getSingleUploadRecord(db, id);
  if (!record) return;

  // 2. delete files
  try {
    const files = record.files;
    await deleteFiles(files.map((file) => file.path));
  } catch {}

  // 3. delete record
  await db.prepare(`DELETE FROM upload_record WHERE id = ?`).bind(id).run();
}
