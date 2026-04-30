import fs from "node:fs";
import path from "node:path";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { parse } from "csv-parse/sync";
import nodemailer from "nodemailer";

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

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function classifySendError(error) {
  const message = error?.message ?? "Unknown send failure.";
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("daily user sending limit exceeded") || lowerMessage.includes("too many messages")) {
    return {
      status: "blocked",
      label: "Blocked",
      reason: "Your Gmail account is temporarily blocked because too many emails were sent."
    };
  }

  if (lowerMessage.includes("invalid recipient") || lowerMessage.includes("recipient address rejected")) {
    return {
      status: "invalid_email",
      label: "Wrong Email",
      reason: "Recipient email was rejected by the mail server."
    };
  }

  if (lowerMessage.includes("authentication") || lowerMessage.includes("username and password not accepted")) {
    return {
      status: "blocked",
      label: "Blocked",
      reason: "Gmail rejected the login. Check your app password."
    };
  }

  return {
    status: "failed",
    label: "No Done",
    reason: message
  };
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
  if (files.length === 0) {
    throw new Error("No certification CSV files were found in be/data.");
  }

  if (!listId) {
    return files[0];
  }

  const selectedFile = files.find((file) => file.id === listId);
  if (!selectedFile) {
    throw new Error(`CSV file not found: ${listId}`);
  }

  return selectedFile;
}

function loadRecipients(listId) {
  const csvFile = resolveCsvFile(listId);
  const csvContent = fs.readFileSync(csvFile.path, "utf-8");
  const rawRows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

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
      skipped.push({ row: rowNumber, reason: "Missing name, email, or certificate link." });
      return;
    }

    if (!isValidEmail(recipient.email)) {
      skipped.push({ row: rowNumber, reason: `Invalid email: ${recipient.email}` });
      return;
    }

    if (!isValidUrl(recipient.certificates)) {
      skipped.push({ row: rowNumber, reason: "Certificate link must be a valid http/https URL." });
      return;
    }

    recipients.push(recipient);
  });

  return {
    list: {
      id: csvFile.id,
      name: csvFile.name
    },
    recipients,
    skipped
  };
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
        ${
          template.bannerUrl
            ? `<img src="${template.bannerUrl}" alt="Event banner" style="max-width:100%;height:auto;border-radius:18px;margin:0 auto 20px;display:block;" />`
            : ""
        }
        <h1 style="margin:16px 0 10px;font-size:36px;line-height:1.2;">${template.title}</h1>
        <p style="margin:0;font-size:16px;opacity:0.9;">Celebrating your participation and effort.</p>
      </div>
      <div style="padding:32px;">
        <p style="margin:0 0 14px;font-size:18px;">Hi ${name},</p>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.8;">
          ${template.letter}
        </p>
        <div style="text-align:center;margin:28px 0 30px;">
          <a href="${certificateUrl}" style="display:inline-block;padding:14px 28px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700;">
            ${template.viewButtonText}
          </a>
        </div>
        <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.7;">
          Best regards,<br />
          Codeathon 2K26 Team
        </p>
      </div>
    </div>
  </body>
</html>`;
}

function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: requireEnv("GMAIL_USER"),
      pass: requireEnv("GMAIL_APP_PASSWORD")
    }
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, sending: isSending });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "Codeathon 2K26 certification mail API is running.",
    endpoints: ["/api/health", "/api/tracks", "/api/lists", "/api/recipients", "/api/send"]
  });
});

app.get("/api/tracks", (_req, res) => {
  const availableEventIds = new Set(listCsvFiles().map((event) => event.id));
  res.json({
    tracks: certificationTracks.map((track) => ({
      ...track,
      events: track.events.map((event) => ({
        ...event,
        available: availableEventIds.has(event.id)
      }))
    }))
  });
});

app.get("/api/lists", (_req, res) => {
  try {
    const trackId = String(_req.query.track ?? "").trim();
    const files = listCsvFiles(trackId);
    res.json({
      lists: files.map(({ id, name, trackId: fileTrackId, trackName }) => ({
        id,
        name,
        trackId: fileTrackId,
        trackName
      }))
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/recipients", (_req, res) => {
  try {
    const { list, recipients, skipped } = loadRecipients(String(_req.query.list ?? ""));
    res.json({
      list,
      recipients,
      skipped
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/send", async (_req, res) => {
  if (isSending) {
    return res.status(409).json({ message: "A send job is already running. Please wait for it to finish." });
  }

  try {
    isSending = true;
    const { list, recipients, skipped } = loadRecipients(String(_req.body?.listId ?? ""));
    const requestedBatchSize = Number.parseInt(String(_req.body?.batchSize ?? ""), 10);
    const batchSize =
      Number.isFinite(requestedBatchSize) && requestedBatchSize > 0
        ? Math.min(requestedBatchSize, recipients.length)
        : recipients.length;
    const recipientsToSend = recipients.slice(0, batchSize);
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
        await transporter.sendMail({
          from: `${fromName} <${fromEmail}>`,
          to: recipient.email,
          subject,
          text: `Hi ${recipient.name},\n\n${template.letter}\n\n${template.viewButtonText}: ${recipient.certificates}\n\nBest regards,\nCodeathon 2K26 Team`,
          html: buildHtml(recipient.name, recipient.certificates, template)
        });
        sent.push(recipient.email);
        const delivery = {
          status: "sent",
          label: "Done",
          reason: "",
          updatedAt: new Date().toISOString()
        };
        results.push({
          email: recipient.email,
          delivery
        });
      } catch (error) {
        const classifiedError = classifySendError(error);
        failed.push({
          email: recipient.email,
          reason: classifiedError.reason
        });
        results.push({
          email: recipient.email,
          delivery: {
            ...classifiedError,
            updatedAt: new Date().toISOString()
          }
        });

        if (classifiedError.status === "blocked") {
          return res.status(429).json({
            message: "Sending stopped because Gmail blocked this account for heavy usage or login issues.",
            processedCount: sent.length + failed.length,
            remainingCount: Math.max(recipients.length - (sent.length + failed.length), 0),
            list,
            sent,
            failed,
            results,
            skipped
          });
        }
      }
    }

    return res.json({
      message: `Processed ${recipientsToSend.length} email(s). ${sent.length} done, ${failed.length} no done, ${skipped.length} skipped from CSV validation.`,
      processedCount: recipientsToSend.length,
      remainingCount: Math.max(recipients.length - recipientsToSend.length, 0),
      list,
      sent,
      failed,
      results,
      skipped
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  } finally {
    isSending = false;
  }
});

export default app;
