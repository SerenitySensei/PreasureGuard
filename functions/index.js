const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const COL = "pressure_readings";
const DEFAULT_LAT = 59.5344;
const DEFAULT_LON = 18.0762;
const SAMPLE_INTERVAL_MINUTES = 5;

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
  const snap = await db.collection(COL)
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
        logger.info("[COLLECT] Starting pressure collection cycle", {
          timestamp: new Date().toISOString()
        });
        const sampledAt = bucketStart(new Date(), SAMPLE_INTERVAL_MINUTES);
    const docRef = db.collection(COL).doc(docIdForBucket(sampledAt));
    const existing = await docRef.get();

    if (existing.exists) {
      logger.info("[COLLECT] Reading already exists for this bucket", {
        bucketTime: sampledAt.toISOString()
      });
      return;
    }

    const lat = configuredCoordinate("PRESSURE_LAT", DEFAULT_LAT);
    const lon = configuredCoordinate("PRESSURE_LON", DEFAULT_LON);
    logger.info("[COLLECT] Fetching pressure data from Open-Meteo", { lat, lon });
    const hpa = await fetchPressureHpa(lat, lon);
    logger.info("[COLLECT] Received pressure reading", { hpa });
    
    const previous = await latestReadingBefore(sampledAt);
    const deltaPerMinute = changePerMinute(hpa, sampledAt, previous);
    logger.info("[COLLECT] Calculated pressure change", {
      deltaPerMinute: deltaPerMinute?.toFixed(6),
      previousHpa: previous?.hpa,
      previousTime: previous?.time.toISOString()
    });

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

    logger.info("[COLLECT] ✅ Pressure reading saved to Firestore", {
      timestamp: sampledAt.toISOString(),
      hpa,
      deltaPerMinute: deltaPerMinute?.toFixed(6),
      location: `${lat.toFixed(4)}, ${lon.toFixed(4)}`
    });
  }
);

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 400;

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

    logger.info("[PURGE] Starting deletion of readings older than 30 days", {
      cutoffDate: cutoff.toISOString(),
      executedAt: new Date().toISOString()
    });

    while (true) {
      const snap = await db.collection(COL)
        .where("timestamp", "<", cutoffTs)
        .limit(DELETE_BATCH_SIZE)
        .get();

      if (snap.empty) break;
      if (snap.empty) {
        logger.info("[PURGE] No more old readings found");
        break;
      }

      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      totalDeleted += snap.size;
      batchCount++;

      logger.info("[PURGE] Deleted batch", {
        batchNum: batchCount,
        docsInBatch: snap.size,
        totalDeletedSoFar: totalDeleted
      });

      if (snap.size < DELETE_BATCH_SIZE) break;
    }

      cutoff: cutoff.toISOString(),
    logger.info("[PURGE] ✅ Purge completed", {
      cutoffDate: cutoff.toISOString(),
      totalBatches: batchCount,
      totalDeleted
      completedAt: new Date().toISOString()
    });
  }
);
