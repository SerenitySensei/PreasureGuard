# 🌡️ Lufttryck – Barometric Pressure Monitor PWA

A Progressive Web App (PWA) that monitors atmospheric pressure in real time, stores readings in Firebase Firestore, and sends push notifications when pressure changes rapidly — with a built-in migraine risk indicator based on published research.

---

## Features

- **Real-time monitoring** – reads pressure from the device's built-in barometer sensor (if available) or via the Open-Meteo API using GPS position
- **Firebase Firestore** – all readings are stored in the cloud with 30 days of history
- **Migraine risk indicator** – assesses risk (low / medium / high) based on published research:
  - Daily pressure drop ≥ 5 hPa = elevated risk (Japanese migraine study)
  - Absolute pressure below 1010–1005 hPa = increased baseline risk
- **Push notifications** – alerts when the daily change exceeds the configured threshold (default 5 hPa) or when pressure is very low
- **History chart** – visualises data over 2 h / 24 h / 7 days / 30 days
- **Statistics** – shows change/min, last hour, Δ since yesterday, and 24 h min/max
- **PWA support** – installable on the home screen on Android and iOS

---

## Files

| File | Description |
|------|-------------|
| `index.html` | The entire app – HTML, CSS and JavaScript in a single file |
| `manifest.json` | PWA manifest (name, icons, theme colour) |
| `sw.js` | Service Worker for offline support and push notifications |

---

## Getting Started

### 1. Firebase Setup

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create a project or use an existing one
3. Enable **Anonymous Authentication**: Authentication → Sign-in method → Anonymous → On
4. Create a **Firestore database** and set the following security rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /pressure_readings/{doc} {
      allow read, write: if request.auth != null;
    }
  }
}
```

5. Get your `firebaseConfig` from Project Settings → Your apps → Web

6. Replace the configuration in `index.html` (search for `firebaseConfig`):

```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};
```

### 2. Deploy

The app requires HTTPS for GPS access and push notifications. Easiest options:

**Netlify** (recommended for beginners)
1. Go to [netlify.com](https://netlify.com) and create a free account
2. Drag and drop the folder with all three files onto the dashboard
3. Done – you get an HTTPS URL immediately

**GitHub Pages**
1. Create a new repository on GitHub
2. Upload the files
3. Go to Settings → Pages → select the main branch

### 3. Install as a Mobile App

1. Open your HTTPS URL in Chrome (Android) or Safari (iOS)
2. Tap the share icon
3. Select "Add to Home Screen"

---

## Data Model (Firestore)

Each reading is stored as a document in the `pressure_readings` collection:

```json
{
  "timestamp": "2025-03-22T10:00:00Z",
  "hpa": 1013.2,
  "source": "api",
  "changePerMin": -0.012,
  "uid": "anonymous-user-id"
}
```

Data older than 30 days can be deleted manually using the button in the app.

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Migraine threshold | 5 hPa/day | Notification sent when the daily change exceeds this value |
| Measurement interval | 10 seconds | How often the app fetches new pressure data |

---

## Migraine Risk – Scientific Background

The risk assessment is based on:

- **Daily pressure change**: A Japanese study found that migraine attacks increased significantly when atmospheric pressure dropped more than 5 hPa from one day to the next in weather-sensitive individuals.
- **Absolute pressure level**: Studies have observed more frequent migraine attacks when pressure falls toward 1006–1010 hPa compared to the normal range around 1013 hPa.

Individual sensitivity varies — this app is a tool to help you track patterns, not a medical diagnosis.

---

## Tech Stack

- **Vanilla HTML/CSS/JavaScript** – no build tools or frameworks
- **Firebase Firestore** – cloud database
- **Firebase Auth** – anonymous authentication
- **Open-Meteo API** – free weather API, no API key required
- **Generic Sensor API** – barometer sensor (supported on select Android devices)
- **Web Notifications API** – push notifications
- **Service Worker** – PWA and offline support
