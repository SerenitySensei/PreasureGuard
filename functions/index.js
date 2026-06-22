const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const PRESSURE_COL = "pressure_readings";
const LOG_COL = "backend_events";
const DEFAULT_LAT = 59.5344;
const DEFAULT_LON = 18.0762;
const SAMPLE_INTERVAL_MINUTES = 5;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 400;

function configuredCoordinate(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }

  return value;
}

function bucketStart(date, intervalMinutes) {
  const intervalMs = intervalMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs);
}

function docIdForBucket(date) {
  return `backend_${date.toISOString().replace(/[:.]/g, "-")}`;
}

async function recordBackendEvent(level, category, message, details = {}) {
  const payload = {
    timestamp: admin.firestore.Timestamp.fromDate(new Date()),
    level,
    category,
    message,
    details,
    source: "backend"
  };

  try {
    await db.collection(LOG_COL).add(payload);
  } catch (error) {
    logger.error("[LOG] Failed to write backend event", {
      level,
      category,
      message,
      error: error.message
    });
  }

  const logMethod = logger[level] || logger.info;
  logMethod(message, { category, ...details });
}

async function fetchPressureHpa(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lon.toFixed(4));
  url.searchParams.set("current", "surface_pressure");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Open-Meteo returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const hpa = data.current && data.current.surface_pressure;

    if (!Number.isFinite(hpa)) {
      throw new Error("Open-Meteo response did not include surface_pressure");
    }

    return hpa;
  } finally {
    clearTimeout(timeout);
  }
}

async function latestReadingBefore(timestamp) {
  const snap = await db.collection(PRESSURE_COL)
    .where("timestamp", "<", admin.firestore.Timestamp.fromDate(timestamp))
    .orderBy("timestamp", "desc")
    .limit(1)
    .get();

  if (snap.empty) return null;

  const data = snap.docs[0].data();
  if (!data.timestamp || !Number.isFinite(data.hpa)) return null;

  return {
    hpa: data.hpa,
    time: data.timestamp.toDate()
  };
}

function changePerMinute(currentHpa, currentTime, previous) {
  if (!previous) return null;

  const minutes = (currentTime.getTime() - previous.time.getTime()) / 60000;
  if (minutes <= 0) return null;

  return (currentHpa - previous.hpa) / minutes;
}

exports.getBackendLogs = onCall(
  { region: "us-central1" },
  async () => {
    try {
      const snap = await db.collection(LOG_COL)
        .orderBy("timestamp", "desc")
        .limit(20)
        .get();

      return {
        logs: snap.docs.map(doc => {
          const data = doc.data();
          return {
            time: data.timestamp?.toMillis ? data.timestamp.toMillis() : Date.now(),
            level: data.level || "info",
            category: data.category || "",
            message: data.message || "(utan meddelande)",
            details: data.details || {}
          };
        })
      };
    } catch (error) {
      logger.error("[LOGS] Failed to fetch backend logs", { error: error.message });
      return { logs: [] };
    }
  }
);

exports.collectPressureReading = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Europe/Stockholm",
    region: "europe-west1",
    timeoutSeconds: 30,
    memory: "256MiB"
  },
  async () => {
    const sampledAt = bucketStart(new Date(), SAMPLE_INTERVAL_MINUTES);
    const docRef = db.collection(PRESSURE_COL).doc(docIdForBucket(sampledAt));
    const existing = await docRef.get();

    if (existing.exists) {
      await recordBackendEvent("info", "collect", "Reading already exists for this bucket", {
        bucketTime: sampledAt.toISOString()
      });
      return;
    }

    const lat = configuredCoordinate("PRESSURE_LAT", DEFAULT_LAT);
    const lon = configuredCoordinate("PRESSURE_LON", DEFAULT_LON);
    await recordBackendEvent("info", "collect", "Collection cycle started", {
      sampledAt: sampledAt.toISOString(),
      location: `${lat.toFixed(4)}, ${lon.toFixed(4)}`
    });

    const hpa = await fetchPressureHpa(lat, lon);
    const previous = await latestReadingBefore(sampledAt);
    const deltaPerMinute = changePerMinute(hpa, sampledAt, previous);

    await docRef.create({
      timestamp: admin.firestore.Timestamp.fromDate(sampledAt),
      hpa: Number(hpa.toFixed(4)),
      source: "backend-open-meteo",
      changePerMin: deltaPerMinute == null ? null : Number(deltaPerMinute.toFixed(6)),
      uid: "backend",
      latitude: Number(lat.toFixed(4)),
      longitude: Number(lon.toFixed(4)),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await recordBackendEvent("info", "collect", "Pressure reading saved to Firestore", {
      timestamp: sampledAt.toISOString(),
      hpa: Number(hpa.toFixed(4)),
      deltaPerMinute: deltaPerMinute == null ? null : Number(deltaPerMinute.toFixed(6)),
      previousHpa: previous?.hpa ?? null,
      location: `${lat.toFixed(4)}, ${lon.toFixed(4)}`
    });
  }
);

exports.purgeOldReadings = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "Europe/Stockholm",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "256MiB"
  },
  async () => {
    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);
    let totalDeleted = 0;
    let batchCount = 0;

    await recordBackendEvent("info", "purge", "Purge started", {
      cutoffDate: cutoff.toISOString()
    });

    while (true) {
      const snap = await db.collection(PRESSURE_COL)
        .where("timestamp", "<", cutoffTs)
        .limit(DELETE_BATCH_SIZE)
        .get();

      if (snap.empty) {
        break;
      }

      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      totalDeleted += snap.size;
      batchCount++;

      await recordBackendEvent("info", "purge", "Deleted batch of old readings", {
        batchNum: batchCount,
        docsInBatch: snap.size,
        totalDeletedSoFar: totalDeleted,
        cutoffDate: cutoff.toISOString()
      });

      if (snap.size < DELETE_BATCH_SIZE) break;
    }

    await recordBackendEvent("info", "purge", "Purge completed", {
      cutoffDate: cutoff.toISOString(),
      totalBatches: batchCount,
      totalDeleted
    });
  }
);
