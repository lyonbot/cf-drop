import { Hono } from "hono";
import {
  createUploadRecord,
  deleteRecord,
  getSingleUploadRecord,
  getUploadRecords,
  migrateTables,
  purgeRecordsBeforeId,
} from "./database";

type Bindings = {
  ASSETS: { fetch: typeof fetch };
  DB: D1Database;
  MY_BUCKET: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/list", async (c) => {
  await migrateTables(c.env.DB);

  const beforeId = +c.req.query("beforeId")!;
  const list = await getUploadRecords(c.env.DB, { beforeId });
  return c.json(list);

  // const r = await createUploadRecord(c.env.DB, {
  //   uploader: 'yon',
  //   size: 0,
  //   files: '',
  //   message: '',
  // })
  // return c.json(r)
});

app.post("/api/upload", async (c) => {
  const uploader = c.req.header("x-uploader") || "unknown";
  const body = await c.req.formData();

  const files = body.getAll("files").filter((file) => file instanceof File);
  const thumbnails = body.getAll("thumbnails") as string[];
  const message = String(body.get("message") || "");

  if (!files.length && !message) {
    return c.json({ error: "No files or message" });
  }

  // upload files to bucket
  const filePathPrefix = `cf_drop/${Date.now()}`;
  const uploadedFiles = await Promise.all(
    files.map(async (file, index) => {
      const fileName = file.name;
      const filePath = `${filePathPrefix}/${fileName}`;
      const r = await c.env.MY_BUCKET.put(filePath, file, {
        httpMetadata: { contentType: file.type },
      });
      return {
        name: fileName,
        path: filePath,
        size: r.size,
        thumbnail: thumbnails[index] || "",
      };
    })
  );

  // create record
  const record = await createUploadRecord(c.env.DB, {
    uploader,
    size: uploadedFiles.reduce((acc, file) => acc + file.size, 0),
    files: uploadedFiles,
    message,
  });

  return c.json({ record });
});

app.get("/api/download/:id/:index", async (c) => {
  const id = +c.req.param("id");
  const index = c.req.param("index");
  const record = await getSingleUploadRecord(c.env.DB, id);
  if (!record) {
    return c.status(404);
  }

  if (index === "message") {
    return c.text(record.message);
  }

  const filePath = record.files[+index]?.path;
  if (!filePath) {
    return c.status(404);
  }

  const r = await c.env.MY_BUCKET.get(filePath, {
    range: c.req.header("range"),
  });

  if (!r) {
    c.status(404);
    return c.json({ error: "File not found" });
  }

  const basename = filePath.split("/").pop()!.replace(/\?.*/, "");
  const headers = new Headers();
  headers.set("accept-ranges", "bytes");

  if (
    !/\.(jpg|png|gif|avif|mp4|mov|txt|html|js|css|json|ya?ml)/.test(basename)
  ) {
    headers.set("content-disposition", `attachment; filename="${basename}"`);
  }

  r.writeHttpMetadata(headers);
  return new Response(r.body, { headers });
});

app.post("/api/delete", async (c) => {
  const body = await c.req.json();
  const id = +body.id;
  await deleteRecord(c.env.DB, id, (paths) => c.env.MY_BUCKET.delete(paths));
  return c.json({ ok: true });
});

app.post("/api/purge", async (c) => {
  const beforeId = 9999999;
  await purgeRecordsBeforeId(c.env.DB, beforeId, (paths) =>
    c.env.MY_BUCKET.delete(paths)
  );
  return c.json({ ok: true });
});

export default app;
