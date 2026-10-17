import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY")!;
const DB = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = "kanako-workspace-files";
const RECORD_TYPES = new Set(["trainees","audits","coachings","weekly_reports","files","feature_ideas","system_logs"]);
const ALLOWED_ORIGINS = new Set([
  "https://kanako-onboarding-progress-hub.vercel.app",
  "https://kanako-progress-hub.vercel.app",
  "https://kanako-progress-hub-vapepokemon143-8805.vercel.app",
  "https://kanako-progress-hub-git-feature-supe-b08eaf-vapepokemon143-8805.vercel.app",
  "http://localhost:8000", "http://127.0.0.1:8000"
]);

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://kanako-progress-hub.vercel.app";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-device-timestamp, x-device-nonce, x-device-signature, x-device-public-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function response(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function cleanUser(u: any) {
  return { id: u.id, username: u.username, email: u.email || "", displayName: u.display_name, role: u.role, active: u.active, createdAt: u.created_at };
}
async function sha256(value: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,"0")).join("");
}
function newToken() {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return [...bytes].map(x => x.toString(16).padStart(2,"0")).join("");
}
function fromB64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function toB64Url(bytes: Uint8Array) {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function samePublicKey(a: any, b: any) {
  return !!a && !!b && a.kty === "EC" && b.kty === "EC" && a.crv === "P-256" && b.crv === "P-256" && a.x === b.x && a.y === b.y;
}
async function verifyDeviceSignature(req: Request, bodyHash: string, userId: string, expectedJwk?: any) {
  const timestamp = req.headers.get("x-device-timestamp") || "";
  const nonce = req.headers.get("x-device-nonce") || "";
  const signature = req.headers.get("x-device-signature") || "";
  const encodedJwk = req.headers.get("x-device-public-key") || "";
  const now = Date.now();
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 5 * 60 * 1000 || !/^[0-9a-f-]{36}$/i.test(nonce) || !signature || !encodedJwk) {
    return { ok: false, message: "Device verification is missing or expired. Refresh and sign in again." };
  }
  let jwk: any;
  try { jwk = JSON.parse(new TextDecoder().decode(fromB64Url(encodedJwk))); } catch { return { ok: false, message: "Invalid device public key." }; }
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || jwk.d) {
    return { ok: false, message: "Invalid device public key." };
  }
  if (expectedJwk && !samePublicKey(jwk, expectedJwk)) return { ok: false, message: "This browser's cryptographic device key does not match the registered device. A Superuser-approved device change is required." };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const message = new TextEncoder().encode(timestamp + "." + nonce + "." + bodyHash);
    valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64Url(signature), message);
  } catch { valid = false; }
  if (!valid) return { ok: false, message: "Device signature verification failed. This request was blocked." };
  await DB.from("workspace_device_signature_nonces").delete().lt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const { error } = await DB.from("workspace_device_signature_nonces").insert({ nonce, user_id: userId });
  if (error?.code === "23505") return { ok: false, message: "This signed request has already been used. Please retry." };
  if (error) throw error;
  return { ok: true, jwk };
}
async function multipartSignatureHash(body: any, uploadFile: File | null) {
  if (!uploadFile) return null;
  const fileDigest = await sha256(toB64Url(new Uint8Array(await uploadFile.arrayBuffer())));
  if (String(body.fileDigest || "") !== fileDigest) return null;
  const canonical = JSON.stringify({
    action: String(body.action || ""), deviceId: String(body.deviceId || ""),
    deviceLabel: String(body.deviceLabel || ""), recordKey: String(body.recordKey || ""),
    kind: String(body.kind || ""), fileName: uploadFile.name, fileSize: uploadFile.size, fileDigest
  });
  return await sha256(canonical);
}
function validUsername(u: string) { return /^[a-z0-9._-]{3,32}$/.test(u); }
function validHashSalt(body: any) {
  return typeof body?.passwordHash === "string" && /^[a-f0-9]{64}$/i.test(body.passwordHash)
    && typeof body?.salt === "string" && body.salt.length >= 16 && body.salt.length <= 128;
}
async function authorizeDevice(user: any, deviceId: string, deviceLabel: string, publicKeyJwk: any) {
  // Superusers are exempt from registered-device approval and key binding.
  if (String(user.role || "").toLowerCase() === "superuser") return { allowed: true };
  if (!/^[a-f0-9-]{36}$/i.test(deviceId)) {
    return { allowed: false, message: "This browser could not be identified. Refresh the page and try again." };
  }
  const label = String(deviceLabel || "Browser device").slice(0, 160);
  let { data: registered, error } = await DB.from("workspace_user_devices")
    .select("device_id,device_label,public_key_jwk").eq("user_id", user.id).maybeSingle();
  if (error) throw error;
  if (!registered) {
    const inserted = await DB.from("workspace_user_devices").insert({
      user_id: user.id, device_id: deviceId, device_label: label, public_key_jwk: publicKeyJwk
    });
    if (inserted.error && inserted.error.code !== "23505") throw inserted.error;
    const reread = await DB.from("workspace_user_devices")
      .select("device_id,device_label").eq("user_id", user.id).maybeSingle();
    if (reread.error) throw reread.error;
    registered = reread.data;
  }
  if (registered?.device_id === deviceId && samePublicKey(registered.public_key_jwk, publicKeyJwk)) return { allowed: true };
  const { data: pending, error: pendingErr } = await DB.from("workspace_device_change_requests")
    .select("id,requested_device_id").eq("user_id", user.id).eq("status", "pending").maybeSingle();
  if (pendingErr) throw pendingErr;
  if (pending) {
    return {
      allowed: false,
      message: pending.requested_device_id === deviceId
        ? "This account is registered to another browser/device. Your device-change request is pending Superuser approval. Please wait for approval before signing in."
        : "A device-change request is already pending for this account. Contact the Superuser if you need to change the requested device."
    };
  }
  const { error: requestErr } = await DB.from("workspace_device_change_requests").insert({
    user_id: user.id, requested_device_id: deviceId, device_label: label,
    requested_public_key_jwk: publicKeyJwk, status: "pending"
  });
  if (requestErr && requestErr.code !== "23505") throw requestErr;
  return {
    allowed: false,
    message: "This account is registered to another browser/device. A device-change request has been submitted for Superuser approval. You can sign in after the Superuser approves it."
  };
}
async function issueSession(user: any, deviceId: string) {
  const token = newToken();
  const { error } = await DB.from("workspace_sessions").upsert({
    user_id: user.id, device_id: deviceId, token_hash: await sha256(token),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  }, { onConflict: "user_id" });
  if (error) throw error;
  return { token, user: cleanUser(user) };
}
async function userForToken(token: string, deviceId: string) {
  if (!token || !/^[a-f0-9-]{36}$/i.test(deviceId)) return null;
  const token_hash = await sha256(token);
  const { data: session, error } = await DB.from("workspace_sessions").select("id,user_id,expires_at,device_id")
    .eq("token_hash", token_hash).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error || !session) return null;
  const { data: user, error: userErr } = await DB.from("workspace_app_users")
    .select("id,username,display_name,role,active,created_at,password_salt,password_hash")
    .eq("id", session.user_id).maybeSingle();
  if (userErr || !user || !user.active) {
    await DB.from("workspace_sessions").delete().eq("id", session.id);
    return null;
  }
  if (String(user.role || "").toLowerCase() !== "superuser") {
    if (session.device_id !== deviceId) return null;
    const { data: registered, error: deviceErr } = await DB.from("workspace_user_devices")
      .select("device_id").eq("user_id", session.user_id).maybeSingle();
    if (deviceErr || !registered || registered.device_id !== deviceId) return null;
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
      const paths = frows.map((x: any) => x.storage_path);
      await DB.storage.from(BUCKET).remove(paths);
      await DB.from("workspace_files").delete().eq("record_key", String(r.record_key));
    }
  }
}
function stableJson(value: any): string { if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return "["+value.map(stableJson).join(",")+"]";return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stableJson(value[k])).join(",")+"}"; }
function footprintLabel(type:string,key:string,p:any){p=p||{};const label=p.full_name||p.trainee_name||p.title||p.file_name||p.display_name||p.name||p.client_name;if(label)return String(label).slice(0,240);if(type==="audits")return [p.audit_date,p.score!=null?String(p.score)+"/"+String(p.max_score||100):""].filter(Boolean).join(" · ")||key;if(type==="coachings")return [p.session_date||p.date,p.trainee_id].filter(Boolean).join(" · ")||key;return key;}
function footprintEntry(user:any,action:string,type:string,key:string,before:any,after:any){const oldValue=before&&typeof before==="object"?before:null,newValue=after&&typeof after==="object"?after:null;const keys=[...new Set([...Object.keys(oldValue||{}),...Object.keys(newValue||{})])].filter(k=>k!=="updated_at"&&k!=="created_at").sort();const changedFields=keys.filter(k=>stableJson(oldValue?.[k]??null)!==stableJson(newValue?.[k]??null)).map(field=>({field,before:oldValue&&oldValue[field]!==undefined?oldValue[field]:null,after:newValue&&newValue[field]!==undefined?newValue[field]:null}));return {actor_id:user.id,actor_username:user.username,actor_display_name:user.display_name,actor_role:user.role,action,record_type:type,record_key:key,record_label:footprintLabel(type,key,newValue||oldValue||{}),changed_fields:changedFields};}
async function handler(req: Request) {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return response(origin, { error: "POST required." }, 405);

  let body: any = {};
  let rawBody = "";
  let uploadFile: File | null = null;
  const ctype = req.headers.get("Content-Type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData();
    body.action = String(form.get("action") || "");
    body.recordKey = String(form.get("recordKey") || "");
    body.kind = String(form.get("kind") || "");
    body.deviceId = String(form.get("deviceId") || "");
    body.deviceLabel = String(form.get("deviceLabel") || "");
    body.fileDigest = String(form.get("fileDigest") || "");
    const f = form.get("file");
    if (f instanceof File) uploadFile = f;
  } else {
    try { rawBody = await req.text(); body = JSON.parse(rawBody); } catch { return response(origin, { error: "Invalid JSON body." }, 400); }
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
      // Initial account setup creates the Superuser, which is exempt from device binding.
      return response(origin, await issueSession(user, String(body.deviceId)), 201);
    }

    if (action === "login-challenge") {
      const username = String(body.username || "").trim().toLowerCase();
      const { data: account, error: accountErr } = await DB.from("workspace_app_users").select("password_salt,active,role").eq("username", username).maybeSingle();
      if (accountErr) throw accountErr;
      const role = account?.active ? String(account.role || "").toLowerCase() : null;
      const { data: security, error: securityErr } = await DB.from("workspace_signin_security")
        .select("failed_attempts,locked_until,unlock_request_status,unlock_requested_at")
        .eq("username", username).maybeSingle();
      if (securityErr) throw securityErr;
      if (security?.locked_until && new Date(security.locked_until).getTime() > Date.now()) {
        const errorMessage = role === "superuser"
          ? "This Superuser account is locked after 3 failed sign-in attempts. Wait for the 24-hour lock to expire."
          : "This account is locked after 3 failed sign-in attempts. Try again after the 24-hour lock expires or request Superuser unlock approval.";
        return response(origin, { error: errorMessage, role, lockedUntil: security.locked_until, unlockRequestStatus: security.unlock_request_status }, 423);
      }
      // Return a dummy salt for unknown/disabled accounts so failed username attempts are counted server-side too.
      return response(origin, { salt: account?.active ? account.password_salt : "kanako-invalid-account-salt-0001", role });
    }

    if (action === "login") {
      const username = String(body.username || "").trim().toLowerCase();
      const { data: security, error: securityErr } = await DB.from("workspace_signin_security")
        .select("failed_attempts,locked_until,unlock_request_status")
        .eq("username", username).maybeSingle();
      if (securityErr) throw securityErr;
      if (security?.locked_until && new Date(security.locked_until).getTime() > Date.now()) {
        return response(origin, { error: "This account is locked after 3 failed sign-in attempts. Try again after the 24-hour lock expires or request Superuser unlock approval.", lockedUntil: security.locked_until, unlockRequestStatus: security.unlock_request_status }, 423);
      }
      const { data: user, error } = await DB.from("workspace_app_users")
        .select("id,username,display_name,role,active,created_at,password_hash")
        .eq("username", username).maybeSingle();
      if (error) throw error;
      if (!/^[a-f0-9]{64}$/i.test(String(body.passwordHash || "")) || !user || !user.active || user.password_hash !== String(body.passwordHash).toLowerCase()) {
        const { data: failureRows, error: failureErr } = await DB.rpc("record_kanako_signin_failure", { p_username: username });
        if (failureErr) throw failureErr;
        const failure = Array.isArray(failureRows) ? failureRows[0] : failureRows;
        if (failure?.is_locked) {
          return response(origin, { error: "Account locked: 3 incorrect sign-in attempts reached. It will unlock automatically after 24 hours, or request Superuser approval.", lockedUntil: failure.locked_until, failedAttempts: failure.failed_attempts }, 423);
        }
        const attemptsRemaining = Math.max(0, 3 - Number(failure?.failed_attempts || 1));
        return response(origin, { error: "Username or password is incorrect, or the account is disabled." + (attemptsRemaining ? " " + attemptsRemaining + " sign-in attempt(s) remaining before a 24-hour lock." : ""), failedAttempts: failure?.failed_attempts || 1, attemptsRemaining }, 401);
      }
      const { error: resetErr } = await DB.rpc("reset_kanako_signin_failures", { p_username: username });
      if (resetErr) throw resetErr;
      if (String(user.role || "").toLowerCase() !== "superuser") {
        const verified = await verifyDeviceSignature(req, await sha256(rawBody), user.id);
        if (!verified.ok) return response(origin, { error: verified.message }, 403);
        const device = await authorizeDevice(user, String(body.deviceId || ""), String(body.deviceLabel || ""), verified.jwk);
        if (!device.allowed) return response(origin, { error: device.message }, 403);
      }
      return response(origin, await issueSession(user, String(body.deviceId)));
    }

    if (action === "unlock-request") {
      const username = String(body.username || "").trim().toLowerCase();
      if (!validUsername(username)) return response(origin, { error: "Enter the username for the locked Admin account." }, 400);
      const { data: account, error: accountErr } = await DB.from("workspace_app_users")
        .select("username,role,active").eq("username", username).maybeSingle();
      if (accountErr) throw accountErr;
      if (!account || !account.active || String(account.role || "").toLowerCase() !== "admin") {
        return response(origin, { error: "Only an active Admin account can request an unlock." }, 403);
      }
      const { data: security, error: securityErr } = await DB.from("workspace_signin_security")
        .select("locked_until,unlock_request_status").eq("username", username).maybeSingle();
      if (securityErr) throw securityErr;
      if (!security?.locked_until || new Date(security.locked_until).getTime() <= Date.now()) {
        return response(origin, { error: "This account is not currently locked. Try signing in again." }, 409);
      }
      if (security.unlock_request_status === "pending") {
        return response(origin, { ok: true, message: "Your unlock request is already waiting for Superuser review." });
      }
      const now = new Date().toISOString();
      const { error: updateErr } = await DB.from("workspace_signin_security").update({
        unlock_requested_at: now, unlock_request_status: "pending", updated_at: now
      }).eq("username", username).gt("locked_until", now);
      if (updateErr) throw updateErr;
      return response(origin, { ok: true, message: "Your unlock request has been sent to the Superuser for review." });
    }

    const token = bearer(req);
    const resolved = await userForToken(token, String(body.deviceId || ""));
    if (!resolved) return response(origin, { error: "Your session expired. Please sign in again." }, 401);
    const user = resolved.user;
    if (String(user.role || "").toLowerCase() !== "superuser") {
      let bodyHash = await sha256(rawBody);
      if (ctype.includes("multipart/form-data")) {
        const multipartHash = await multipartSignatureHash(body, uploadFile);
        if (!multipartHash) return response(origin, { error: "Uploaded file digest verification failed." }, 403);
        bodyHash = multipartHash;
      }
      const { data: registeredDevice, error: registeredError } = await DB.from("workspace_user_devices")
        .select("public_key_jwk").eq("user_id", user.id).maybeSingle();
      if (registeredError) throw registeredError;
      if (!registeredDevice?.public_key_jwk) return response(origin, { error: "This account needs Superuser approval to register its cryptographic device key." }, 403);
      const verified = await verifyDeviceSignature(req, bodyHash, user.id, registeredDevice.public_key_jwk);
      if (!verified.ok) return response(origin, { error: verified.message }, 403);
    }

    if (action === "ai-coaching-feedback") {
      const apiKey = Deno.env.get("OPENROUTER_API_KEY") || "";
      if (!apiKey) return response(origin, { error: "AI coaching is not configured yet. Add OPENROUTER_API_KEY to the Supabase Edge Function secrets, then retry." }, 503);
      const input = body.coaching && typeof body.coaching === "object" ? body.coaching : {};
      const traineeName = String(input.traineeName || "the VA").slice(0, 160);
      const strengths = String(input.strengths || "").trim().slice(0, 5000);
      const improvements = String(input.areasForImprovement || "").trim().slice(0, 7000);
      const auditNotes = String(input.auditNotes || "").trim().slice(0, 4000);
      const auditScore = String(input.auditScore || "").slice(0, 40);
      const auditDate = String(input.auditDate || "").slice(0, 40);
      const sessionDate = String(input.sessionDate || "").slice(0, 40);
      const existingPlan = String(input.currentSmartPlan || "").trim().slice(0, 2500);
      if (!strengths && !improvements && !auditNotes) return response(origin, { error: "Add Strengths / Wins, Areas for Improvement, or linked QA findings before generating feedback." }, 400);
      const systemPrompt = "You are Kanako's evidence-based VA coaching assistant. Use only supplied QA/coaching evidence; do not invent behaviors, scores, incidents, causes, or achievements. Keep feedback supportive, specific, professional, non-interrogative, and actionable. Do not make employment decisions or claim certainty beyond the evidence. The VA must create their own SMART action plan, so ask the exact coaching question and provide prompts, but do not write the VA's plan for them. Return valid JSON only with string keys discussion_feedback and expected_outcome.";
      const userPrompt = `Create coaching feedback using this exact structure and headings:
Performance Assessment
Strengths:
Areas for Improvement:
SMART Coaching Discussion
[VA name], what is your SMART action plan for addressing these areas of improvement?
Please consider:
- Specific: What exact skills or behaviors will you work on improving?
- Measurable: How will you measure your progress?
- Achievable: What specific steps will you take to improve?
- Relevant: How will your plan address the findings from your call audit?
- Time-bound: When do you plan to achieve your target?
Expected Outcome:

VA name: ${traineeName}
Coaching session date: ${sessionDate || "Not provided"}
QA audit date: ${auditDate || "Not provided"}
QA audit score: ${auditScore || "Not provided"}
Strengths / Wins supplied by trainer:
${strengths || "Not provided"}
Areas for Improvement supplied by trainer:
${improvements || "Not provided"}
Other QA audit findings/notes:
${auditNotes || "Not provided"}
Existing trainee SMART plan (context only; do not rewrite it):
${existingPlan || "Not provided"}

Use concise bullets for strengths and improvement areas, preserving the trainer's meaning. If a category has no evidence, say "No specific evidence provided" rather than guessing. Tie expected outcomes directly to stated improvement areas and frame them as targets, not guaranteed results. discussion_feedback must contain the complete structured template including the exact SMART question and all five prompts. expected_outcome should be a concise separate paragraph with 1–3 observable outcomes.`;
      const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json", "HTTP-Referer": "https://kanako-progress-hub.vercel.app", "X-Title": "Kanako Coaching Tracker" },
        body: JSON.stringify({ model: "openrouter/free", temperature: 0.2, max_tokens: 1200, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(45000)
      });
      if (!aiResponse.ok) {
        const detail = (await aiResponse.text()).slice(0, 500);
        console.error("OpenRouter coaching request failed:", aiResponse.status, detail);
        return response(origin, { error: aiResponse.status === 401 ? "OpenRouter rejected the API key. Check the OPENROUTER_API_KEY secret." : aiResponse.status === 429 ? "The free AI request limit has been reached. Please try again later." : "OpenRouter could not generate feedback right now. Please try again shortly." }, aiResponse.status === 429 ? 429 : 502);
      }
      const completion = await aiResponse.json();
      const content = completion?.choices?.[0]?.message?.content;
      let generated: any;
      try { generated = typeof content === "string" ? JSON.parse(content) : content; } catch { generated = null; }
      const discussionFeedback = String(generated?.discussion_feedback || "").trim();
      const expectedOutcome = String(generated?.expected_outcome || "").trim();
      if (!discussionFeedback || !expectedOutcome) return response(origin, { error: "The AI returned an incomplete response. Please generate again." }, 502);
      return response(origin, { discussionFeedback, expectedOutcome, model: completion?.model || "openrouter/free" });
    }

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
    if (action === "device-requests-list") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can review device-change requests." }, 403);
      const { data: requests, error } = await DB.from("workspace_device_change_requests")
        .select("id,user_id,requested_device_id,device_label,requested_public_key_jwk,status,requested_at,reviewed_at,review_note")
        .eq("status", "pending").order("requested_at", { ascending: true });
      if (error) throw error;
      const userIds = [...new Set((requests || []).map((r: any) => r.user_id))];
      const { data: owners, error: ownersErr } = userIds.length
        ? await DB.from("workspace_app_users").select("id,username,display_name").in("id", userIds)
        : { data: [], error: null };
      if (ownersErr) throw ownersErr;
      const ownerMap = new Map((owners || []).map((u: any) => [u.id, u]));
      return response(origin, { requests: (requests || []).map((r: any) => ({
        ...r, username: ownerMap.get(r.user_id)?.username || "unknown",
        display_name: ownerMap.get(r.user_id)?.display_name || "Unknown user"
      })) });
    }
    if (action === "device-request-review") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can approve device changes." }, 403);
      const requestId = String(body.requestId || "");
      const decision = String(body.decision || "");
      if (!/^[0-9a-f-]{36}$/i.test(requestId) || !["approve", "reject"].includes(decision)) {
        return response(origin, { error: "Invalid device-change review request." }, 400);
      }
      const { data: request, error: requestErr } = await DB.from("workspace_device_change_requests")
        .select("id,user_id,requested_device_id,device_label,requested_public_key_jwk,status")
        .eq("id", requestId).eq("status", "pending").maybeSingle();
      if (requestErr) throw requestErr;
      if (!request) return response(origin, { error: "This request has already been reviewed or no longer exists." }, 404);
      if (decision === "approve") {
        const { error: deviceErr } = await DB.from("workspace_user_devices").upsert({
          user_id: request.user_id, device_id: request.requested_device_id,
          device_label: request.device_label, public_key_jwk: request.requested_public_key_jwk,
          updated_at: new Date().toISOString()
        }, { onConflict: "user_id" });
        if (deviceErr) throw deviceErr;
        const { error: sessionErr } = await DB.from("workspace_sessions").delete().eq("user_id", request.user_id);
        if (sessionErr) throw sessionErr;
      }
      const { error: updateErr } = await DB.from("workspace_device_change_requests").update({
        status: decision === "approve" ? "approved" : "rejected",
        reviewed_at: new Date().toISOString(), reviewed_by: user.id,
        review_note: String(body.note || "").slice(0, 500) || null
      }).eq("id", request.id).eq("status", "pending");
      if (updateErr) throw updateErr;
      return response(origin, { ok: true, status: decision === "approve" ? "approved" : "rejected" });
    }
    if (action === "unlock-requests-list") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can review unlock requests." }, 403);
      const { data, error } = await DB.from("workspace_signin_security")
        .select("username,failed_attempts,locked_until,unlock_requested_at,unlock_request_status")
        .eq("unlock_request_status", "pending").order("unlock_requested_at", { ascending: true });
      if (error) throw error;
      const pending = (data || []).filter((r: any) => r.locked_until && new Date(r.locked_until).getTime() > Date.now());
      const usernames = pending.map((r: any) => r.username);
      const { data: accounts, error: accountErr } = usernames.length ? await DB.from("workspace_app_users").select("username,email,display_name").in("username", usernames) : { data: [], error: null };
      if (accountErr) throw accountErr;
      const byUsername = new Map((accounts || []).map((a: any) => [a.username, a]));
      return response(origin, { requests: pending.map((r: any) => ({ ...r, email: byUsername.get(r.username)?.email || "", display_name: byUsername.get(r.username)?.display_name || r.username })) });
    }
    if (action === "unlock-request-review") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can review unlock requests." }, 403);
      const username = String(body.username || "").trim().toLowerCase();
      const decision = String(body.decision || "");
      if (!username || !["approve", "deny"].includes(decision)) return response(origin, { error: "Invalid unlock request decision." }, 400);
      const { data: target, error: targetErr } = await DB.from("workspace_signin_security")
        .select("username,locked_until,unlock_request_status").eq("username", username).eq("unlock_request_status", "pending").maybeSingle();
      if (targetErr) throw targetErr;
      if (!target) return response(origin, { error: "Pending unlock request not found." }, 404);
      const update = decision === "approve"
        ? { failed_attempts: 0, locked_until: null, unlock_requested_at: null, unlock_request_status: "approved", updated_at: new Date().toISOString() }
        : { unlock_requested_at: null, unlock_request_status: "none", updated_at: new Date().toISOString() };
      const { error } = await DB.from("workspace_signin_security").update(update).eq("username", username).eq("unlock_request_status", "pending");
      if (error) throw error;
      return response(origin, { ok: true, username, status: decision === "approve" ? "unlocked" : "denied" });
    }

    if (action === "users-list") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can manage accounts." }, 403);
      const { data, error } = await DB.from("workspace_app_users").select("id,username,email,display_name,role,active,created_at").eq("role", "admin").order("display_name");
      if (error) throw error;
      return response(origin, { users: (data || []).map(cleanUser) });
    }
    if (action === "users-create") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can create accounts." }, 403);
      const username = String(body.username || "").trim().toLowerCase(), displayName = String(body.displayName || "").trim(), email = String(body.email || "").trim().toLowerCase();
      if (!displayName || !validUsername(username) || !/^[^\s@]+@[^\s@]+[.][^\s@]+$/.test(email) || email.length > 254 || !validHashSalt(body) || String(body.password || "").length !== 0) return response(origin, { error: "Enter a valid email address and complete all required account details." }, 400);
      const { data, error } = await DB.from("workspace_app_users").insert({ username, email, display_name: displayName, role: "admin", active: true, password_salt: body.salt, password_hash: String(body.passwordHash).toLowerCase() }).select("id,username,email,display_name,role,active,created_at").single();
      if (error) return response(origin, { error: error.code === "23505" ? "That username or email address is already registered." : error.message }, error.code === "23505" ? 409 : 400);
      return response(origin, { user: cleanUser(data) }, 201);
    }
    if (action === "users-email-update") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can update account email addresses." }, 403);
      const id = String(body.id || ""), email = String(body.email || "").trim().toLowerCase();
      if (!id || !/^[^\s@]+@[^\s@]+[.][^\s@]+$/.test(email) || email.length > 254) return response(origin, { error: "Enter a valid email address." }, 400);
      const { data: target, error: targetErr } = await DB.from("workspace_app_users").select("id,role").eq("id", id).maybeSingle();
      if (targetErr) throw targetErr;
      if (!target || target.role !== "admin") return response(origin, { error: "Admin account not found." }, 404);
      const { data, error } = await DB.from("workspace_app_users").update({ email, updated_at: new Date().toISOString() }).eq("id", id).select("id,username,email,display_name,role,active,created_at").single();
      if (error) return response(origin, { error: error.code === "23505" ? "That email address is already registered to another account." : error.message }, error.code === "23505" ? 409 : 400);
      return response(origin, { user: cleanUser(data) });
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
    if (action === "users-delete") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can delete Admin accounts." }, 403);
      const id = String(body.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return response(origin, { error: "Invalid Admin account identifier." }, 400);
      const { data: target, error: targetErr } = await DB.from("workspace_app_users")
        .select("id,username,display_name,role,active,email,created_at").eq("id", id).maybeSingle();
      if (targetErr) throw targetErr;
      if (!target || target.role !== "admin") return response(origin, { error: "Admin account not found." }, 404);

      const suppliedPassword = typeof body.superuserPassword === "string" ? body.superuserPassword : "";
      if (!suppliedPassword || suppliedPassword.length > 1024) return response(origin, { error: "Enter your Superuser password to confirm deletion." }, 400);
      const { data: superuserRecord, error: passwordLookupError } = await DB.from("workspace_app_users")
        .select("id,role,password_salt,password_hash,active").eq("id", user.id).maybeSingle();
      if (passwordLookupError) throw passwordLookupError;
      if (!superuserRecord || superuserRecord.role !== "superuser" || !superuserRecord.active) return response(origin, { error: "Superuser account could not be verified." }, 403);
      const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(suppliedPassword), "PBKDF2", false, ["deriveBits"]);
      const passwordBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(superuserRecord.password_salt), iterations: 120000, hash: "SHA-256" }, passwordKey, 256);
      const calculatedHash = [...new Uint8Array(passwordBits)].map(x => x.toString(16).padStart(2, "0")).join("");
      if (calculatedHash !== String(superuserRecord.password_hash || "").toLowerCase()) return response(origin, { error: "Incorrect Superuser password. The Admin account was not deleted." }, 403);

      const { error: auditError } = await DB.from("workspace_audit_footprints").insert({
        actor_id: user.id, actor_username: user.username, actor_display_name: user.display_name, actor_role: user.role,
        action: "deleted", record_type: "admin_account", record_key: target.id,
        record_label: (target.display_name || target.username).slice(0, 240),
        changed_fields: [{ field: "account", before: { username: target.username, email: target.email, role: target.role, active: target.active }, after: null }],
        before_data: { username: target.username, email: target.email, display_name: target.display_name, role: target.role, active: target.active, created_at: target.created_at },
        after_data: null
      });
      if (auditError) throw auditError;

      const { error: securityError } = await DB.from("workspace_signin_security").delete().eq("username", target.username);
      if (securityError) throw securityError;
      const { error: deleteError } = await DB.from("workspace_app_users").delete().eq("id", target.id).eq("role", "admin");
      if (deleteError) throw deleteError;
      return response(origin, { ok: true, deleted: true, username: target.username });
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
    if (action === "footprints-list") {
      if (user.role !== "superuser" && user.role !== "admin") return response(origin, { error: "Only Admin and Superuser accounts can view the change footprint." }, 403);
      const { data, error } = await DB.from("workspace_audit_footprints").select("id,occurred_at,actor_username,actor_display_name,actor_role,action,record_type,record_key,record_label,changed_fields").order("occurred_at", { ascending: false }).limit(1000);
      if (error) throw error;
      return response(origin, { footprints: data || [] });
    }
    if (action === "system-log-add") {
      const level = ["error","warning"].includes(String(body.level)) ? String(body.level) : "error";
      const message = String(body.message || "Unknown application error").slice(0, 500);
      const details = String(body.details || "").slice(0, 3000);
      const logId = crypto.randomUUID();
      const payload = { id: logId, level, message, details, source: String(body.source || "app").slice(0, 80), route: String(body.route || "").slice(0, 160), occurredAt: String(body.occurredAt || new Date().toISOString()).slice(0, 40), userId: user.id, username: user.username, displayName: user.display_name };
      const { error } = await DB.from("workspace_records").insert({ record_type: "system_logs", record_key: logId, payload, created_by: user.id, updated_at: new Date().toISOString() });
      if (error) throw error;
      return response(origin, { ok: true, id: logId }, 201);
    }
    if (action === "system-logs-list") {
      if (user.role !== "superuser" && user.role !== "admin") return response(origin, { error: "Only Admin and Superuser accounts can view system logs." }, 403);
      const { data, error } = await DB.from("workspace_records").select("record_key,payload,updated_at").eq("record_type", "system_logs").order("updated_at", { ascending: false }).limit(500);
      if (error) throw error;
      return response(origin, { logs: (data || []).map(row => ({ ...(row.payload || {}), id: row.record_key, updatedAt: row.updated_at })) });
    }
    if (action === "system-logs-clear") {
      if (user.role !== "superuser") return response(origin, { error: "Only the Superuser can clear system logs." }, 403);
      const { error } = await DB.from("workspace_records").delete().eq("record_type", "system_logs");
      if (error) throw error;
      return response(origin, { ok: true });
    }
    if (action === "data-pull") {
      const records = await listWorkspaceRecords();
      return response(origin, { records: user.role === "superuser" ? records : records.filter((r: any) => r.record_type !== "system_logs") });
    }
    if (action === "data-sync") {
      const upsert = Array.isArray(body.upsert) ? body.upsert : [];
      const deletes = Array.isArray(body.deletes) ? body.deletes : [];
      if (upsert.some((r:any)=>String(r?.record_type)==="system_logs")||deletes.some((r:any)=>String(r?.record_type)==="system_logs")) return response(origin,{error:"System logs must use the protected log endpoints."},403);
      if(upsert.length>3000||deletes.length>3000)return response(origin,{error:"Invalid or oversized change batch."},400);
      const footprints:any[]=[];
      const groups=new Map<string,any[]>();
      for(const row of upsert){const type=String(row.record_type);if(!groups.has(type))groups.set(type,[]);groups.get(type)!.push(row);}
      for(const [type,rows] of groups){const keys=[...new Set(rows.map((r:any)=>String(r.record_key)))];const {data:existing,error}=await DB.from("workspace_records").select("record_key,payload").eq("record_type",type).in("record_key",keys);if(error)throw error;const previous=new Map((existing||[]).map((r:any)=>[String(r.record_key),r.payload]));for(const row of rows){const key=String(row.record_key),before=previous.get(key)??null;if(stableJson(before)!==stableJson(row.payload))footprints.push(footprintEntry(user,before?"updated":"created",type,key,before,row.payload));}}
      const deleteGroups=new Map<string,any[]>();
      for(const row of deletes){const type=String(row.record_type);if(!deleteGroups.has(type))deleteGroups.set(type,[]);deleteGroups.get(type)!.push(row);}
      for(const [type,rows] of deleteGroups){const keys=[...new Set(rows.map((r:any)=>String(r.record_key)))];const {data:existing,error}=await DB.from("workspace_records").select("record_key,payload").eq("record_type",type).in("record_key",keys);if(error)throw error;const previous=new Map((existing||[]).map((r:any)=>[String(r.record_key),r.payload]));for(const row of rows){const key=String(row.record_key),before=previous.get(key);if(before)footprints.push(footprintEntry(user,"deleted",type,key,before,null));}}
      await upsertRecords(upsert,user.id);await deleteRecords(deletes);
      if(footprints.length){const {error}=await DB.from("workspace_audit_footprints").insert(footprints);if(error)throw error;}
      return response(origin,{ok:true,upserted:upsert.length,deleted:deletes.length,footprint_entries:footprints.length});
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
      const { error: footprintError } = await DB.from("workspace_audit_footprints").insert({actor_id:user.id,actor_username:user.username,actor_display_name:user.display_name,actor_role:user.role,action:"attachment_uploaded",record_type:"attachment",record_key:recordKey,record_label:uploadFile.name.slice(0,240),changed_fields:[{field:"file_name",before:null,after:uploadFile.name},{field:"file_type",before:null,after:kind},{field:"size_bytes",before:null,after:uploadFile.size},{field:"storage_path",before:null,after:storagePath}]});
      if(footprintError)throw footprintError;
      return response(origin, { path: storagePath, fileName: uploadFile.name, size: uploadFile.size, contentType });
    }
    if (action === "file-url") {
      const path = String(body.path || "");
      if (!path || path.length > 500 || path.startsWith("/") || path.includes("..")) return response(origin, { error: "Invalid file path." }, 400);
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
