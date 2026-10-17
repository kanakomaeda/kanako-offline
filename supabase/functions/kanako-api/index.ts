import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "npm:@aws-sdk/client-s3@3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY")!;
const DB = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = "kanako-workspace-files";
const B2_KEY_ID = Deno.env.get("B2_KEY_ID") || "";
const B2_APPLICATION_KEY = Deno.env.get("B2_APPLICATION_KEY") || "";
const B2_BUCKET_NAME = Deno.env.get("B2_BUCKET_NAME") || "";
const B2_S3_ENDPOINT = Deno.env.get("B2_S3_ENDPOINT") || "";
const B2_REGION = B2_S3_ENDPOINT.match(/s3[.]([a-z0-9-]+)[.]backblazeb2[.]com/i)?.[1] || "us-east-005";
const B2_READY = !!(B2_KEY_ID && B2_APPLICATION_KEY && B2_BUCKET_NAME && B2_S3_ENDPOINT);
const B2 = B2_READY ? new S3Client({ region: B2_REGION, endpoint: B2_S3_ENDPOINT.startsWith("http") ? B2_S3_ENDPOINT : "https://" + B2_S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APPLICATION_KEY } }) : null;
const RECORD_TYPES = new Set(["trainees","audits","coachings","weekly_reports","files","feature_ideas"]);
const ALLOWED_ORIGINS = new Set([
  "https://kanako-progress-hub.vercel.app",
  "https://kanako-progress-hub-vapepokemon143-8805.vercel.app",
  "http://localhost:8000", "http://127.0.0.1:8000"
]);

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://kanako-progress-hub.vercel.app";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function response(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function cleanUser(u: any) {
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: u.active, createdAt: u.created_at };
}
async function sha256(value: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,"0")).join("");
}
function newToken() {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return [...bytes].map(x => x.toString(16).padStart(2,"0")).join("");
}
function validUsername(u: string) { return /^[a-z0-9._-]{3,32}$/.test(u); }
function validHashSalt(body: any) {
  return typeof body?.passwordHash === "string" && /^[a-f0-9]{64}$/i.test(body.passwordHash)
    && typeof body?.salt === "string" && body.salt.length >= 16 && body.salt.length <= 128;
}
async function issueSession(user: any) {
  const token = newToken();
  const { error } = await DB.from("workspace_sessions").insert({
    user_id: user.id, token_hash: await sha256(token),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  if (error) throw error;
  return { token, user: cleanUser(user) };
}
async function userForToken(token: string) {
  if (!token) return null;
  const token_hash = await sha256(token);
  const { data: session, error } = await DB.from("workspace_sessions").select("id,user_id,expires_at")
    .eq("token_hash", token_hash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error || !session) return null;
  const { data: user, error: userErr } = await DB.from("workspace_app_users")
    .select("id,username,display_name,role,active,created_at,password_salt,password_hash")
    .eq("id", session.user_id).maybeSingle();
  if (userErr || !user || !user.active) {
    await DB.from("workspace_sessions").delete().eq("id", session.id);
    return null;
  }
  return { user, session };
}
function bearer(req: Request) {
  const value = req.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}
async function listWorkspaceRecords() {
  const { data, error } = await DB.from("workspace_records").select("record_type,record_key,payload,updated_at");
  if (error) throw error;
  return data || [];
}
async function upsertRecords(rows: any[], userId: string) {
  if (!Array.isArray(rows) || rows.length > 3000) throw new Error("Invalid or oversized record batch.");
  const clean = rows.map((r: any) => {
    if (!RECORD_TYPES.has(String(r.record_type)) || !String(r.record_key || "").trim() || !r.payload || typeof r.payload !== "object") throw new Error("Invalid record in sync batch.");
    return { record_type: String(r.record_type), record_key: String(r.record_key), payload: r.payload, created_by: userId, updated_at: new Date().toISOString() };
  });
  if (!clean.length) return;
  const { error } = await DB.from("workspace_records").upsert(clean, { onConflict: "record_type,record_key" });
  if (error) throw error;
}
async function deleteRecords(rows: any[]) {
  if (!Array.isArray(rows) || rows.length > 3000) throw new Error("Invalid delete batch.");
  for (const r of rows) {
    if (!RECORD_TYPES.has(String(r.record_type)) || !String(r.record_key || "").trim()) throw new Error("Invalid record delete request.");
    const { error } = await DB.from("workspace_records").delete().eq("record_type", String(r.record_type)).eq("record_key", String(r.record_key));
    if (error) throw error;
    const { data: frows } = await DB.from("workspace_files").select("storage_path").eq("record_key", String(r.record_key));
    if (frows?.length) {
      const paths = frows.map((x: any) => String(x.storage_path));
      const b2Paths = paths.filter((p: string) => p.startsWith("b2/")).map((p: string) => p.slice(3));
      const legacyPaths = paths.filter((p: string) => !p.startsWith("b2/"));
      if (B2 && b2Paths.length) await Promise.all(b2Paths.map((Key: string) => B2.send(new DeleteObjectCommand({ Bucket: B2_BUCKET_NAME, Key }))));
      if (legacyPaths.length) await DB.storage.from(BUCKET).remove(legacyPaths);
      await DB.from("workspace_files").delete().eq("record_key", String(r.record_key));
    }
  }
}
async function handler(req: Request) {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return response(origin, { error: "POST required." }, 405);

  let body: any = {};
  let uploadFile: File | null = null;
  const ctype = req.headers.get("Content-Type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData();
    body.action = String(form.get("action") || "");
    body.recordKey = String(form.get("recordKey") || "");
    body.kind = String(form.get("kind") || "");
    const f = form.get("file");
    if (f instanceof File) uploadFile = f;
  } else {
    try { body = await req.json(); } catch { return response(origin, { error: "Invalid JSON body." }, 400); }
  }
  const action = String(body.action || "");

  try {
    if (action === "status") {
      const [{ count, error: countErr }, { data: cfg, error: cfgErr }] = await Promise.all([
        DB.from("workspace_app_users").select("id", { count: "exact", head: true }),
        DB.from("workspace_setup_config").select("id").eq("id", true).maybeSingle()
      ]);
      if (countErr) throw countErr;
      if (cfgErr) throw cfgErr;
      return response(origin, { setup_required: (count || 0) === 0 && !!cfg, available: true });
    }

    if (action === "setup") {
      const displayName = String(body.displayName || "").trim();
      const username = String(body.username || "").trim().toLowerCase();
      if (!displayName || !validUsername(username) || !validHashSalt(body) || String(body.setupCode || "").length < 20) {
        return response(origin, { error: "Complete every field and enter the one-time setup code." }, 400);
      }
      const { count, error: countErr } = await DB.from("workspace_app_users").select("id", { count: "exact", head: true });
      if (countErr) throw countErr;
      if ((count || 0) > 0) return response(origin, { error: "Initial setup has already been completed. Please sign in." }, 409);
      const { data: cfg, error: cfgErr } = await DB.from("workspace_setup_config").select("setup_code_hash").eq("id", true).maybeSingle();
      if (cfgErr) throw cfgErr;
      if (!cfg || await sha256(String(body.setupCode)) !== cfg.setup_code_hash) return response(origin, { error: "The one-time setup code is incorrect." }, 403);
      const { data: user, error } = await DB.from("workspace_app_users").insert({
        display_name: displayName, username, role: "superuser", active: true,
        password_salt: body.salt, password_hash: body.passwordHash.toLowerCase()
      }).select("id,username,display_name,role,active,created_at").single();
      if (error) {
        if (error.code === "23505") return response(origin, { error: "That username is already in use." }, 409);
        throw error;
      }
      await DB.from("workspace_setup_config").delete().eq("id", true);
      const legacyAdmins = Array.isArray(body.legacyAdmins) ? body.legacyAdmins.slice(0, 100) : [];
      for (const admin of legacyAdmins) {
        const legacyUsername = String(admin?.username || "").trim().toLowerCase();
        if (legacyUsername === username || !validUsername(legacyUsername) || !validHashSalt({ salt: admin?.salt, passwordHash: admin?.passwordHash })) continue;
        await DB.from("workspace_app_users").upsert({
          username: legacyUsername,
          display_name: String(admin?.displayName || legacyUsername).slice(0, 80),
          role: "admin", active: true, password_salt: admin.salt, password_hash: String(admin.passwordHash).toLowerCase()
        }, { onConflict: "username", ignoreDuplicates: true });
      }
      return response(origin, await issueSession(user), 201);
    }

    if (action === "login-challenge") {
      const username = String(body.username || "").trim().toLowerCase();
      const { data, error } = await DB.from("workspace_app_users").select("password_salt,active").eq("username", username).maybeSingle();
      if (error) throw error;
      return response(origin, { salt: data?.active ? data.password_salt : null });
    }

    if (action === "login") {
      const username = String(body.username || "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/i.test(String(body.passwordHash || ""))) return response(origin, { error: "Username or password is incorrect, or the account is disabled." }, 401);
      const { data: user, error } = await DB.from("workspace_app_users")
        .select("id,username,display_name,role,active,created_at,password_hash")
        .eq("username", username).maybeSingle();
      if (error) throw error;
      if (!user || !user.active || user.password_hash !== String(body.passwordHash).toLowerCase()) return response(origin, { error: "Username or password is incorrect, or the account is disabled." }, 401);
      return response(origin, await issueSession(user));
    }

    const token = bearer(req);
    const resolved = await userForToken(token);
    if (!resolved) return response(origin, { error: "Your session expired. Please sign in again." }, 401);
    const user = resolved.user;

    if (action === "me") return response(origin, { user: cleanUser(user), salt: user.password_salt });
    if (action === "logout") {
      await DB.from("workspace_sessions").delete().eq("id", resolved.session.id);
      return response(origin, { ok: true });
    }
    if (action === "password-challenge") return response(origin, { salt: user.password_salt });
    if (action === "password-change") {
      if (String(body.currentPasswordHash || "") !== user.password_hash || !validHashSalt({ salt: body.newSalt, passwordHash: body.newPasswordHash })) {
        return response(origin, { error: "Your current password is incorrect or the new password is invalid." }, 400);
      }
      const { error } = await DB.from("workspace_app_users").update({ password_salt: body.newSalt, password_hash: String(body.newPasswordHash).toLowerCase(), updated_at: new Date().toISOString() }).eq("id", user.id);
      if (error) throw error;
      return response(origin, { ok: true });
    }
    if (action === "users-list") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can manage accounts." }, 403);
      const { data, error } = await DB.from("workspace_app_users").select("id,username,display_name,role,active,created_at").eq("role", "admin").order("display_name");
      if (error) throw error;
      return response(origin, { users: (data || []).map(cleanUser) });
    }
    if (action === "users-create") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can create accounts." }, 403);
      const username = String(body.username || "").trim().toLowerCase(), displayName = String(body.displayName || "").trim();
      if (!displayName || !validUsername(username) || !validHashSalt(body) || String(body.password || "").length !== 0) return response(origin, { error: "Invalid account details." }, 400);
      const { data, error } = await DB.from("workspace_app_users").insert({ username, display_name: displayName, role: "admin", active: true, password_salt: body.salt, password_hash: String(body.passwordHash).toLowerCase() }).select("id,username,display_name,role,active,created_at").single();
      if (error) return response(origin, { error: error.code === "23505" ? "That username is already in use." : error.message }, error.code === "23505" ? 409 : 400);
      return response(origin, { user: cleanUser(data) }, 201);
    }
    if (action === "users-toggle") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can manage accounts." }, 403);
      const active = !!body.active;
      const { data: target, error: targetErr } = await DB.from("workspace_app_users").select("id,role").eq("id", String(body.id || "")).maybeSingle();
      if (targetErr) throw targetErr;
      if (!target || target.role !== "admin") return response(origin, { error: "Admin account not found." }, 404);
      const { error } = await DB.from("workspace_app_users").update({ active, updated_at: new Date().toISOString() }).eq("id", target.id);
      if (error) throw error;
      if (!active) await DB.from("workspace_sessions").delete().eq("user_id", target.id);
      return response(origin, { ok: true });
    }
    if (action === "users-reset") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can reset Admin passwords." }, 403);
      if (!validHashSalt(body)) return response(origin, { error: "Invalid password details." }, 400);
      const { data: target, error: targetErr } = await DB.from("workspace_app_users").select("id,role").eq("id", String(body.id || "")).maybeSingle();
      if (targetErr) throw targetErr;
      if (!target || target.role !== "admin") return response(origin, { error: "Admin account not found." }, 404);
      const { error } = await DB.from("workspace_app_users").update({ password_salt: body.salt, password_hash: String(body.passwordHash).toLowerCase(), updated_at: new Date().toISOString() }).eq("id", target.id);
      if (error) throw error;
      await DB.from("workspace_sessions").delete().eq("user_id", target.id);
      return response(origin, { ok: true });
    }
    if (action === "data-pull") {
      const records = await listWorkspaceRecords();
      return response(origin, { records });
    }
    if (action === "data-sync") {
      const upsert = Array.isArray(body.upsert) ? body.upsert : [];
      const deletes = Array.isArray(body.deletes) ? body.deletes : [];
      await upsertRecords(upsert, user.id);
      await deleteRecords(deletes);
      return response(origin, { ok: true, upserted: upsert.length, deleted: deletes.length });
    }
    if (action === "file-upload-url") {
      if (!B2) return response(origin, { useLegacy: true });
      const recordKey = String(body.recordKey || ""), kind = String(body.kind || ""), fileName = String(body.fileName || "");
      const size = Number(body.size || 0), contentType = String(body.contentType || (kind === "mp4" ? "video/mp4" : "application/pdf"));
      if (!/^[a-zA-Z0-9_-]{3,100}$/.test(recordKey) || !["pdf","mp4","auditpdf"].includes(kind)) return response(origin, { error: "Invalid file reference." }, 400);
      const maxBytes = kind === "mp4" ? 100 * 1024 * 1024 : 45 * 1024 * 1024;
      if (!Number.isFinite(size) || size <= 0 || size > maxBytes) return response(origin, { error: kind === "mp4" ? "Files must be 100 MB or smaller." : "Files must be 45 MB or smaller." }, 413);
      if (!fileName || fileName.length > 255) return response(origin, { error: "Invalid file name." }, 400);
      if (kind === "mp4" && !["video/mp4","application/octet-stream"].includes(contentType)) return response(origin, { error: "Only MP4 recordings are supported." }, 415);
      if (kind !== "mp4" && contentType !== "application/pdf" && !fileName.toLowerCase().endsWith(".pdf")) return response(origin, { error: "Only PDF audit files are supported." }, 415);
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || (kind === "mp4" ? "recording.mp4" : "audit.pdf");
      const path = "b2/" + recordKey + "/" + kind + "-" + safeName;
      const uploadUrl = await getSignedUrl(B2, new PutObjectCommand({ Bucket: B2_BUCKET_NAME, Key: path.slice(3), ContentType: contentType }), { expiresIn: 600 });
      return response(origin, { uploadUrl, path, contentType, expiresIn: 600 });
    }
    if (action === "file-upload-complete") {
      if (!B2) return response(origin, { error: "Backblaze storage is not configured yet." }, 503);
      const recordKey = String(body.recordKey || ""), kind = String(body.kind || ""), path = String(body.path || "");
      const fileName = String(body.fileName || ""), size = Number(body.size || 0);
      const contentType = String(body.contentType || (kind === "mp4" ? "video/mp4" : "application/pdf"));
      if (!/^[a-zA-Z0-9_-]{3,100}$/.test(recordKey) || !["pdf","mp4","auditpdf"].includes(kind) || !path.startsWith("b2/" + recordKey + "/" + kind + "-") || path.includes("..")) return response(origin, { error: "Invalid file reference." }, 400);
      const maxBytes = kind === "mp4" ? 100 * 1024 * 1024 : 45 * 1024 * 1024;
      if (!Number.isFinite(size) || size <= 0 || size > maxBytes) return response(origin, { error: "File size is invalid." }, 413);
      const head = await B2.send(new HeadObjectCommand({ Bucket: B2_BUCKET_NAME, Key: path.slice(3) }));
      if (Number(head.ContentLength || 0) !== size) return response(origin, { error: "Uploaded file size verification failed." }, 400);
      const { error: metadataError } = await DB.from("workspace_files").upsert({ record_type: kind, record_key: recordKey, storage_path: path, file_name: fileName, mime_type: contentType, size_bytes: size, metadata: { storageProvider: "backblaze-b2" }, created_by: user.id }, { onConflict: "storage_path" });
      if (metadataError) throw metadataError;
      return response(origin, { path, fileName, size, contentType });
    }
    if (action === "file-upload") {
      if (!uploadFile) return response(origin, { error: "No file was attached." }, 400);
      const recordKey = String(body.recordKey || ""), kind = String(body.kind || "");
      if (!/^[a-zA-Z0-9_-]{3,100}$/.test(recordKey) || !["pdf","mp4","auditpdf"].includes(kind)) return response(origin, { error: "Invalid file reference." }, 400);
      
const maxBytes = kind === "mp4" ? 100 * 1024 * 1024 : 45 * 1024 * 1024;
const maxLabel = kind === "mp4" ? "100 MB" : "45 MB";
if (uploadFile.size <= 0 || uploadFile.size > maxBytes) {
  return response(origin, { error: `Files must be ${maxLabel} or smaller.` }, 413);
}

      const contentType = uploadFile.type || (kind === "mp4" ? "video/mp4" : "application/pdf");
      if (kind === "mp4" && contentType !== "video/mp4" && contentType !== "application/octet-stream") return response(origin, { error: "Only MP4 recordings are supported." }, 415);
      if (kind !== "mp4" && contentType !== "application/pdf" && !uploadFile.name.toLowerCase().endsWith(".pdf")) return response(origin, { error: "Only PDF audit files are supported." }, 415);
      const safeName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || (kind === "mp4" ? "recording.mp4" : "audit.pdf");
      const storagePath = `${recordKey}/${kind}-${safeName}`;
      const bytes = new Uint8Array(await uploadFile.arrayBuffer());
      const { error: storageError } = await DB.storage.from(BUCKET).upload(storagePath, bytes, { upsert: true, contentType, cacheControl: "3600" });
      if (storageError) throw storageError;
      const { error: metadataError } = await DB.from("workspace_files").upsert({
        record_type: kind, record_key: recordKey, storage_path: storagePath, file_name: uploadFile.name,
        mime_type: contentType, size_bytes: uploadFile.size, metadata: {}, created_by: user.id
      }, { onConflict: "storage_path" });
      if (metadataError) throw metadataError;
      return response(origin, { path: storagePath, fileName: uploadFile.name, size: uploadFile.size, contentType });
    }
    if (action === "file-url") {
      const path = String(body.path || "");
      if (!path || path.length > 500 || path.startsWith("/") || path.includes("..")) return response(origin, { error: "Invalid file path." }, 400);
      if (path.startsWith("b2/")) {
        if (!B2) return response(origin, { error: "Backblaze storage is not configured yet." }, 503);
        const url = await getSignedUrl(B2, new GetObjectCommand({ Bucket: B2_BUCKET_NAME, Key: path.slice(3) }), { expiresIn: 600 });
        return response(origin, { url });
      }
      const { data, error } = await DB.storage.from(BUCKET).createSignedUrl(path, 600);
      if (error) throw error;
      return response(origin, { url: data.signedUrl });
    }
    return response(origin, { error: "Unknown action." }, 404);
  } catch (err) {
    console.error("kanako-api error:", err);
    return response(origin, { error: err instanceof Error ? err.message : "Unexpected server error." }, 500);
  }
}

Deno.serve(handler);
