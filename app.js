import fs from "node:fs";
import path from "node:path";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { parse } from "csv-parse/sync";
import nodemailer from "nodemailer";
import { getDb } from "./db.js";

dotenv.config();

const app = express();
const projectDirectory = process.cwd();
const dataDirectory = path.resolve(projectDirectory, "data");
let isSending = false;

const certificationTracks = [
  {
    id: "demo",
    name: "Demo Category",
    events: [{ id: "recipients.csv", name: "Recipients Confirmation" }]
  },
  {
    id: "tech",
    name: "Tech Certification",
    events: [
      { id: "tech-webdevelopment.csv", name: "Web Development" },
      { id: "tech-hackathon.csv", name: "Hackathon" },
      { id: "tech-crakthecode.csv", name: "Crak The Code" }
    ]
  },
  {
    id: "nontech",
    name: "Nontech Certification",
    events: [
      { id: "nontech-presentation.csv", name: "Presentation" },
      { id: "nontech-circutron.csv", name: "Circutron" },
      { id: "nontech-tecchquiz.csv", name: "Tecchquiz" }
    ]
  }
];

app.use(cors());
app.use(express.json());

function logServerError(scope, error) {
  console.error(`[${scope}]`, error);
}

function isMongoConfigured() {
  return Boolean(process.env.MONGODB_URI?.trim());
}

function sanitizeFilename(value) {
  const base = String(value ?? "")
    .trim()
    .replace(/\.csv$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (base || "recipients") + ".csv";
}

function getFileExtension(value) {
  return path.extname(String(value ?? "")).toLowerCase();
}

function escapeCsvCell(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function stringifyRecipientsCsv(rows) {
  const header = ["Name", "Email", "Certificate"];
  const body = rows.map((row) =>
    [row.Name ?? row.name ?? "", row.Email ?? row.email ?? "", row.Certificate ?? row.certificate ?? row.certificates ?? ""]
      .map(escapeCsvCell).join(",")
  );
  return [header.join(","), ...body].join("\n");
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

function classifySendError(error) {
  const message = error?.message ?? "Unknown send failure.";
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes("daily user sending limit exceeded") || lowerMessage.includes("too many messages")) {
    return { status: "blocked", label: "Blocked", reason: "Your Gmail account is temporarily blocked because too many emails were sent." };
  }
  if (lowerMessage.includes("invalid recipient") || lowerMessage.includes("recipient address rejected")) {
    return { status: "invalid_email", label: "Wrong Email", reason: "Recipient email was rejected by the mail server." };
  }
  if (lowerMessage.includes("authentication") || lowerMessage.includes("username and password not accepted")) {
    return { status: "blocked", label: "Blocked", reason: "Gmail rejected the login. Check your app password." };
  }
  return { status: "failed", label: "No Done", reason: message };
}

function getCertificationEvents() {
  return certificationTracks.flatMap((track) =>
    track.events.map((event) => ({
      ...event,
      trackId: track.id,
      trackName: track.name,
      path: path.resolve(dataDirectory, event.id),
      exists: fs.existsSync(path.resolve(dataDirectory, event.id))
    }))
  );
}

function listCsvFiles(trackId) {
  const events = getCertificationEvents().filter((event) => (trackId ? event.trackId === trackId : true));
  return events.filter((event) => event.exists);
}

function resolveCsvFile(listId) {
  const files = listCsvFiles();
  if (files.length === 0) throw new Error("No certification CSV files were found in be/data.");
  if (!listId) return files[0];
  const selectedFile = files.find((file) => file.id === listId);
  if (!selectedFile) throw new Error(`CSV file not found: ${listId}`);
  return selectedFile;
}

async function listStoredFiles(listId) {
  if (!isMongoConfigured()) return [];
  const db = await getDb();
  return db.collection("csv_uploads").find({ listId }).sort({ uploadedAt: -1 }).limit(1000).toArray();
}

async function getLatestStoredFile(listId) {
  const files = await listStoredFiles(listId);
  return files[0] ?? null;
}

async function loadListContent(listId) {
  const csvFile = resolveCsvFile(listId);
  const storedFile = await getLatestStoredFile(csvFile.id);

  if (storedFile) {
    if (getFileExtension(storedFile.filename) !== ".csv") {
      throw new Error("The uploaded file for this event is not a CSV. Delete it or upload a CSV file to continue.");
    }
    return {
      list: { id: csvFile.id, name: csvFile.name },
      csvContent: storedFile.content,
      source: { type: "mongodb", label: "MongoDB Upload", pathname: storedFile.filename, url: null, uploadedAt: storedFile.uploadedAt, filename: storedFile.filename }
    };
  }

  return {
    list: { id: csvFile.id, name: csvFile.name },
    csvContent: fs.readFileSync(csvFile.path, "utf-8"),
    source: { type: "local", label: "Local Bundle", pathname: csvFile.path, url: null, uploadedAt: null, filename: csvFile.id }
  };
}

async function saveRecipientsForSource(listId, rows, source) {
  const csvContent = stringifyRecipientsCsv(rows);

  if (source?.type === "mongodb") {
    if (!isMongoConfigured()) throw new Error("MongoDB is not configured, so the uploaded file cannot be updated.");
    const db = await getDb();
    const filename = sanitizeFilename(source.filename || listId);
    const uploadedAt = new Date().toISOString();
    await db.collection("csv_uploads").insertOne({ listId, filename, content: csvContent, uploadedAt });
    return { type: "mongodb", label: "MongoDB Upload", pathname: filename, url: null, uploadedAt, filename };
  }

  const csvFile = resolveCsvFile(listId);
  fs.writeFileSync(csvFile.path, `${csvContent}\n`, "utf-8");
  return { type: "local", label: "Local Bundle", pathname: csvFile.path, url: null, uploadedAt: null, filename: csvFile.id };
}

async function loadRecipients(listId) {
  const { list, csvContent, source } = await loadListContent(listId);
  const rawRows = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
  const recipients = [];
  const skipped = [];

  rawRows.forEach((row, index) => {
    const recipient = {
      name: (row.name ?? row.Name ?? "").trim(),
      email: (row.email ?? row.Email ?? "").trim(),
      certificates: (row.certificates ?? row.Certificate ?? row.certificate ?? "").trim()
    };
    const rowNumber = index + 2;
    if (!recipient.name || !recipient.email || !recipient.certificates) {
      skipped.push({ row: rowNumber, reason: "Missing name, email, or certificate link." }); return;
    }
    if (!isValidEmail(recipient.email)) {
      skipped.push({ row: rowNumber, reason: `Invalid email: ${recipient.email}` }); return;
    }
    if (!isValidUrl(recipient.certificates)) {
      skipped.push({ row: rowNumber, reason: "Certificate link must be a valid http/https URL." }); return;
    }
    recipients.push(recipient);
  });

  return { list, recipients, skipped, source };
}

function normalizeTemplate(input) {
  return {
    bannerUrl: String(input?.bannerUrl ?? "").trim(),
    title: String(input?.title ?? "").trim() || "Your Certificate Is Ready",
    letter: String(input?.letter ?? "").trim() || "Your participation certificate is available now.",
    viewButtonText: String(input?.viewButtonText ?? "").trim() || "View Certificate"
  };
}

function buildHtml(name, certificateUrl, template) {
  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#efe4d1;font-family:Verdana,sans-serif;color:#1f2937;">
    <div style="max-width:680px;margin:24px auto;background:#fffdf8;border:1px solid #e8d9bc;border-radius:24px;overflow:hidden;">
      <div style="padding:40px 28px;background:radial-gradient(circle at top left,#f97316,#7c2d12 55%,#111827);color:#ffffff;text-align:center;">
        ${template.bannerUrl ? `<img src="${template.bannerUrl}" alt="Event banner" style="max-width:100%;height:auto;border-radius:18px;margin:0 auto 20px;display:block;" />` : ""}
        <h1 style="margin:16px 0 10px;font-size:36px;line-height:1.2;">${template.title}</h1>
        <p style="margin:0;font-size:16px;opacity:0.9;">Celebrating your participation and effort.</p>
      </div>
      <div style="padding:32px;">
        <p style="margin:0 0 14px;font-size:18px;">Hi ${name},</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.8;">${template.letter}</p>
        <div style="text-align:center;margin:28px 0 30px;">
          <a href="${certificateUrl}" style="display:inline-block;padding:14px 28px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700;">${template.viewButtonText}</a>
        </div>
        <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.7;">Best regards,<br />Codeathon 2K26 Team</p>
      </div>
    </div>
  </body>
</html>`;
}

function extractDriveFileId(url) {
  try {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

async function fetchCertificateAttachment(certificateUrl) {
  const fileId = extractDriveFileId(certificateUrl);
  if (!fileId) return null;
  const response = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`);
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return { filename: "certificate.pdf", content: buffer, contentType: "application/pdf" };
}

function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: requireEnv("GMAIL_USER"), pass: requireEnv("GMAIL_APP_PASSWORD") }
  });
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body instanceof Buffer) { resolve(req.body); return; }
    if (typeof req.body === "string") { resolve(Buffer.from(req.body, "utf-8")); return; }
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      resolve(Buffer.from(JSON.stringify(req.body), "utf-8")); return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, sending: isSending, mongodbConfigured: isMongoConfigured() });
});

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Codeathon 2K26 certification mail API is running.", endpoints: ["/api/health", "/api/tracks", "/api/lists", "/api/recipients", "/api/send"] });
});

app.get("/api/tracks", (_req, res) => {
  const availableEventIds = new Set(listCsvFiles().map((event) => event.id));
  res.json({
    tracks: certificationTracks.map((track) => ({
      ...track,
      events: track.events.map((event) => ({ ...event, available: availableEventIds.has(event.id) }))
    }))
  });
});

app.get("/api/lists", (_req, res) => {
  try {
    const trackId = String(_req.query.track ?? "").trim();
    const files = listCsvFiles(trackId);
    res.json({ lists: files.map(({ id, name, trackId: fileTrackId, trackName }) => ({ id, name, trackId: fileTrackId, trackName })) });
  } catch (error) {
    logServerError("api/lists", error);
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/recipients", async (_req, res) => {
  try {
    const listId = String(_req.query.list ?? "");
    const { list, recipients, skipped, source } = await loadRecipients(listId);

    let sentEmails = new Set();
    if (isMongoConfigured()) {
      const db = await getDb();
      const sentDocs = await db.collection("sent_log").find({ listId }, { projection: { email: 1 } }).toArray();
      sentEmails = new Set(sentDocs.map((d) => d.email.toLowerCase()));
    }

    const recipientsWithStatus = recipients.map((r) => ({
      ...r,
      delivery: sentEmails.has(r.email.toLowerCase()) ? { status: "sent", label: "Done", reason: "" } : { status: "pending" }
    }));

    res.json({ list, recipients: recipientsWithStatus, skipped, source });
  } catch (error) {
    logServerError("api/recipients", error);
    res.status(500).json({ message: error.message });
  }
});

app.delete("/api/recipients", async (_req, res) => {
  try {
    const listId = String(_req.body?.listId ?? "").trim();
    const email = String(_req.body?.email ?? "").trim().toLowerCase();
    if (!listId || !email) return res.status(400).json({ message: "Both listId and email are required to delete a recipient." });

    const { list, csvContent, source } = await loadListContent(listId);
    const rawRows = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
    const remainingRows = rawRows.filter((row) => String(row.email ?? row.Email ?? "").trim().toLowerCase() !== email);

    if (remainingRows.length === rawRows.length) {
      return res.status(404).json({ message: `No recipient with email ${email} was found in ${list.name}.` });
    }

    const nextSource = await saveRecipientsForSource(list.id, remainingRows, source);
    return res.json({ message: `Deleted recipient ${email} from ${list.name}.`, source: nextSource });
  } catch (error) {
    logServerError("api/recipients/delete", error);
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/lists/:listId/upload", async (_req, res) => {
  try {
    const listId = String(_req.params.listId ?? "").trim();
    const list = resolveCsvFile(listId);

    if (!isMongoConfigured()) {
      return res.status(503).json({ message: "MongoDB is not configured. Add MONGODB_URI to the backend environment before uploading files." });
    }

    const originalFilename = sanitizeFilename(String(_req.query.filename ?? list.id));
    const body = await readRawBody(_req);

    if (body.length === 0) return res.status(400).json({ message: "Upload failed because the file was empty." });

    const content = body.toString("utf-8");
    parse(content, { columns: true, skip_empty_lines: true, trim: true });

    const db = await getDb();
    const uploadedAt = new Date().toISOString();
    await db.collection("csv_uploads").insertOne({ listId, filename: originalFilename, content, uploadedAt });

    return res.json({
      message: `Uploaded ${originalFilename} for ${list.name}. The dashboard will now use this stored CSV.`,
      source: { type: "mongodb", label: "MongoDB Upload", pathname: originalFilename, url: null, uploadedAt, filename: originalFilename }
    });
  } catch (error) {
    logServerError("api/lists/upload", error);
    return res.status(500).json({ message: error.message });
  }
});

app.delete("/api/lists/:listId/upload", async (_req, res) => {
  try {
    const listId = String(_req.params.listId ?? "").trim();
    const list = resolveCsvFile(listId);

    if (!isMongoConfigured()) {
      return res.status(503).json({ message: "MongoDB is not configured, so there is no cloud file to delete for this event." });
    }

    const storedFiles = await listStoredFiles(list.id);
    if (storedFiles.length === 0) return res.status(404).json({ message: "No uploaded CSV file was found for this event." });

    const db = await getDb();
    await db.collection("csv_uploads").deleteMany({ listId });
    return res.json({ message: `Deleted ${storedFiles.length} uploaded file(s) for ${list.name}. The dashboard will now fall back to the local bundled CSV.` });
  } catch (error) {
    logServerError("api/lists/delete-upload", error);
    return res.status(500).json({ message: error.message });
  }
});

app.delete("/api/lists/:listId/sent-log", async (_req, res) => {
  try {
    const listId = String(_req.params.listId ?? "").trim();
    const db = await getDb();
    const result = await db.collection("sent_log").deleteMany({ listId });
    return res.json({ message: `Cleared ${result.deletedCount} sent log entries for ${listId}.` });
  } catch (error) {
    logServerError("api/lists/sent-log", error);
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/send", async (_req, res) => {
  if (isSending) return res.status(409).json({ message: "A send job is already running. Please wait for it to finish." });

  try {
    isSending = true;
    const requestedEmails = Array.isArray(_req.body?.emails) && _req.body.emails.length > 0
      ? new Set(_req.body.emails.map((e) => String(e).trim().toLowerCase()))
      : null;

    if (!requestedEmails) {
      isSending = false;
      return res.status(400).json({ message: "No emails selected. Check the rows you want to send and try again." });
    }

    const listId = String(_req.body?.listId ?? "").trim();
    const { list, recipients, skipped, source } = await loadRecipients(listId);

    let alreadySent = new Set();
    if (isMongoConfigured()) {
      const db = await getDb();
      const sentDocs = await db.collection("sent_log").find({ listId }, { projection: { email: 1 } }).toArray();
      alreadySent = new Set(sentDocs.map((d) => d.email.toLowerCase()));
    }

    const recipientsToSend = recipients.filter((r) => {
      const email = r.email.trim().toLowerCase();
      return requestedEmails.has(email) && !alreadySent.has(email);
    });

    if (recipientsToSend.length === 0) {
      isSending = false;
      return res.status(200).json({ message: "All selected recipients have already been sent. No duplicates sent.", processedCount: 0, remainingCount: 0, list, source, sent: [], failed: [], results: [], skipped });
    }

    const transporter = createTransporter();
    const fromName = requireEnv("FROM_NAME");
    const fromEmail = requireEnv("GMAIL_USER");
    const subject = requireEnv("EMAIL_SUBJECT");
    const template = normalizeTemplate(_req.body?.template);
    const sent = [];
    const failed = [];
    const results = [];

    await transporter.verify();

    for (const recipient of recipientsToSend) {
      try {
        const attachment = await fetchCertificateAttachment(recipient.certificates);
        await transporter.sendMail({
          from: `${fromName} <${fromEmail}>`,
          to: recipient.email,
          subject,
          text: `Hi ${recipient.name},\n\n${template.letter}\n\n${template.viewButtonText}: ${recipient.certificates}\n\nBest regards,\nCodeathon 2K26 Team`,
          html: buildHtml(recipient.name, recipient.certificates, template),
          attachments: attachment ? [attachment] : []
        });
        sent.push(recipient.email);
        const delivery = { status: "sent", label: "Done", reason: "", updatedAt: new Date().toISOString() };
        results.push({ email: recipient.email, delivery });

        if (isMongoConfigured()) {
          const db = await getDb();
          await db.collection("sent_log").insertOne({ listId, email: recipient.email.trim().toLowerCase(), sentAt: delivery.updatedAt });
        }
      } catch (error) {
        const classifiedError = classifySendError(error);
        failed.push({ email: recipient.email, reason: classifiedError.reason });
        results.push({ email: recipient.email, delivery: { ...classifiedError, updatedAt: new Date().toISOString() } });

        if (classifiedError.status === "blocked") {
          return res.status(429).json({
            message: "Sending stopped because Gmail blocked this account for heavy usage, limit issues, or login problems.",
            processedCount: sent.length + failed.length,
            remainingCount: Math.max(recipients.length - (sent.length + failed.length), 0),
            list, source, sent, failed, results, skipped
          });
        }
      }
    }

    return res.json({
      message: `Processed ${recipientsToSend.length} email(s). ${sent.length} done, ${failed.length} failed.`,
      processedCount: recipientsToSend.length,
      remainingCount: Math.max(recipients.length - recipientsToSend.length, 0),
      list, source, sent, failed, results, skipped
    });
  } catch (error) {
    logServerError("api/send", error);
    return res.status(500).json({ message: error.message });
  } finally {
    isSending = false;
  }
});

export default app;
