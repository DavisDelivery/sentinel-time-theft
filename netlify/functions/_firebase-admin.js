// netlify/functions/_firebase-admin.js
// Shared Firebase Admin init for server-side Firestore access
// Uses FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY env vars

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let _db = null;

export function getDb() {
  if (_db) return _db;

  if (!getApps().length) {
    const projectId = Netlify.env.get('FIREBASE_PROJECT_ID');
    const clientEmail = Netlify.env.get('FIREBASE_CLIENT_EMAIL');
    let privateKey = Netlify.env.get('FIREBASE_PRIVATE_KEY');
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Firebase env vars not set: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    }
    // Handle escaped newlines from env var
    privateKey = privateKey.replace(/\\n/g, '\n');
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey })
    });
  }
  _db = getFirestore();
  return _db;
}
