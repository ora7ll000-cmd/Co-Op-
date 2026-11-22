// Firebase Client Configuration and Firestore Service
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  initializeFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  getDocFromServer,
  writeBatch,
  getDocs
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
}, (firebaseConfig as any).firestoreDatabaseId || '(default)');

// Test connection
(async () => {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    // Offline or expected non-existent test document
  }
})();

export type RemoteVoteRecord = {
  uid: string;
  name?: string;
  v: string[];
  updatedAt?: string;
};

/**
 * Listens in real time to all votes submitted by all players worldwide.
 * Any vote added, removed or changed triggers the callback instantly.
 */
export function subscribeToAllVotes(
  onUpdate: (summary: Record<string, { n: number; uids: string[]; names: string[] }>, totalVoters: number) => void
) {
  try {
    const colRef = collection(db, 'votes');
    return onSnapshot(
      colRef,
      (snapshot) => {
        const votesSummary: Record<string, { n: number; uids: string[]; names: string[] }> = {};
        let totalVoters = 0;

        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as RemoteVoteRecord;
          const userList = Array.isArray(data.v) ? data.v : [];
          if (userList.length > 0) totalVoters++;

          for (const gameId of userList) {
            if (!votesSummary[gameId]) {
              votesSummary[gameId] = { n: 0, uids: [], names: [] };
            }
            votesSummary[gameId].n++;
            votesSummary[gameId].uids.push(data.uid || docSnap.id);
            if (data.name && !votesSummary[gameId].names.includes(data.name)) {
              votesSummary[gameId].names.push(data.name);
            }
          }
        });

        onUpdate(votesSummary, totalVoters);
      },
      (error) => {
        console.warn('Firebase snapshot listener error:', error);
      }
    );
  } catch (err) {
    console.warn('Could not initialize Firebase snapshot listener:', err);
    return () => {};
  }
}

/**
 * Publishes the current user's votes to Firestore in real time.
 */
export async function syncUserVoteToFirebase(uid: string, votedGameIds: string[], name: string): Promise<boolean> {
  try {
    const docRef = doc(db, 'votes', uid);
    if (votedGameIds.length === 0) {
      await deleteDoc(docRef);
    } else {
      await setDoc(docRef, {
        uid,
        name: name || '',
        v: votedGameIds,
        updatedAt: new Date().toISOString()
      });
    }
    return true;
  } catch (err) {
    console.error('Failed to sync vote to Firebase:', err);
    return false;
  }
}

/**
 * Admin action: Resets all votes across all players in Firestore.
 */
export async function resetAllFirebaseVotes(): Promise<boolean> {
  try {
    const colRef = collection(db, 'votes');
    const snapshot = await getDocs(colRef);
    const batch = writeBatch(db);
    snapshot.forEach(d => {
      batch.delete(d.ref);
    });
    await batch.commit();
    return true;
  } catch (err) {
    console.error('Failed to reset votes in Firebase:', err);
    return false;
  }
}
