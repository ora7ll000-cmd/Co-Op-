// Firebase Client Configuration and Multi-Group Firestore Service
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  getDocFromServer,
  writeBatch,
  getDocs,
  runTransaction
} from 'firebase/firestore';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db = initializeFirestore(
  app,
  { experimentalForceLongPolling: true },
  (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId || '(default)'
);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write'
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map(provider => ({
          providerId: provider.providerId,
          email: provider.email
        })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
if (typeof window !== 'undefined') {
  setTimeout(() => {
    void testConnection();
  }, 50);
} else {
  void testConnection();
}

export type GroupRecord = {
  code: string;
  name: string;
  slug: string;
  adminName: string;
  adminPinHash: string;
  adminPinSalt: string;
  joinPassHash?: string;
  joinPassSalt?: string;
  createdAt: string;
  updatedAt?: string;
};

export type GroupGameRecord = {
  id: string;
  name: string;
  price: number;
  old?: number;
  order?: number;
  link?: string;
  img?: string;
  ar?: number;
  players?: string;
  desc?: string;
  goal?: string;
  sp?: number | string;
  sc?: number;
  screenshots?: string[];
  trailer?: string;
  trailerPoster?: string;
};

export type VoteSummary = Record<string, { n: number; uids: string[]; names: string[] }>;

export type RemoteVoteRecord = {
  uid: string;
  name?: string;
  v: string[];
  updatedAt?: string;
};

export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function normalizeGroupNameSlug(name: string): Promise<string> {
  const normalized = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return sha256Hex('coop-group-name:' + normalized);
}

export function sanitizeId(raw: string): string {
  const cleaned = String(raw || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 120);
  return cleaned || 'id_' + Date.now().toString(36);
}

export function sanitizeGroupCode(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

function sanitizeGamePayload(raw: GroupGameRecord): GroupGameRecord {
  const safeId = sanitizeId(raw.id);
  const out: GroupGameRecord = {
    id: safeId,
    name: String(raw.name || 'Game').trim().slice(0, 140) || 'Game',
    price: Math.max(0, Number(raw.price) || 0)
  };

  if (typeof raw.old === 'number' && !Number.isNaN(raw.old) && raw.old >= 0) {
    out.old = raw.old;
  }
  if (typeof raw.order === 'number' && !Number.isNaN(raw.order)) {
    out.order = raw.order;
  }
  if (raw.link) out.link = String(raw.link).trim().slice(0, 600);
  if (raw.img) out.img = String(raw.img).slice(0, 900000);
  if (typeof raw.ar === 'number' && !Number.isNaN(raw.ar)) out.ar = raw.ar;
  if (raw.players) out.players = String(raw.players).trim().slice(0, 40);
  if (raw.desc) out.desc = String(raw.desc).trim().slice(0, 1500);
  if (raw.goal) out.goal = String(raw.goal).trim().slice(0, 1500);
  if (raw.sp !== undefined && raw.sp !== '') {
    out.sp = typeof raw.sp === 'number' ? raw.sp : String(raw.sp).slice(0, 16);
  }
  if (typeof raw.sc === 'number' && !Number.isNaN(raw.sc)) out.sc = raw.sc;
  if (Array.isArray(raw.screenshots)) {
    const cleanShots = raw.screenshots.map(s => String(s || '').trim()).filter(Boolean).slice(0, 10);
    out.screenshots = cleanShots;
  }
  if (raw.trailer) out.trailer = String(raw.trailer).trim().slice(0, 600);
  if (raw.trailerPoster) out.trailerPoster = String(raw.trailerPoster).slice(0, 200000);

  // Guard against Firestore 1MB document limit by trimming heavy inline screenshots if needed
  const approxBytes = new Blob([JSON.stringify(out)]).size;
  if (approxBytes > 900000 && Array.isArray(out.screenshots)) {
    while (out.screenshots.length > 0 && new Blob([JSON.stringify(out)]).size > 900000) {
      out.screenshots.pop();
    }
  }
  return out;
}

export async function checkGroupNameAvailable(name: string): Promise<boolean> {
  const slug = await normalizeGroupNameSlug(name);
  const path = `group_names/${slug}`;
  try {
    const snap = await getDoc(doc(db, 'group_names', slug));
    return !snap.exists();
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function createGroupInFirebase(
  group: GroupRecord,
  initialGames: GroupGameRecord[]
): Promise<{ ok: boolean; reason?: 'duplicate_name' | 'duplicate_code' }> {
  const code = sanitizeGroupCode(group.code);
  const name = group.name.trim().slice(0, 80);
  const slug = group.slug || (await normalizeGroupNameSlug(name));
  const now = group.createdAt || new Date().toISOString();

  const lockRef = doc(db, 'group_names', slug);
  const groupRef = doc(db, 'groups', code);

  try {
    const outcome = await runTransaction(db, async tx => {
      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists()) return 'duplicate_name' as const;

      const grpSnap = await tx.get(groupRef);
      if (grpSnap.exists()) return 'duplicate_code' as const;

      tx.set(lockRef, {
        slug,
        name,
        groupCode: code,
        createdAt: now
      });

      tx.set(groupRef, {
        code,
        name,
        slug,
        adminName: group.adminName.trim().slice(0, 60),
        adminPinHash: group.adminPinHash,
        adminPinSalt: group.adminPinSalt,
        createdAt: now
      });

      return 'created' as const;
    });

    if (outcome !== 'created') {
      return { ok: false, reason: outcome };
    }

    if (initialGames.length > 0) {
      await seedGroupGamesInFirebase(code, initialGames);
    }
    return { ok: true };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `groups/${code}`);
  }
}

export async function getGroupFromFirebase(rawCode: string): Promise<GroupRecord | null> {
  const code = sanitizeGroupCode(rawCode);
  if (!code || code.length < 4) return null;
  const path = `groups/${code}`;
  try {
    const snap = await getDoc(doc(db, 'groups', code));
    if (!snap.exists()) return null;
    return snap.data() as GroupRecord;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function getGroupByNameFromFirebase(rawName: string): Promise<GroupRecord | null> {
  const cleanName = String(rawName || '').trim();
  if (cleanName.length < 2) return null;
  const slug = await normalizeGroupNameSlug(cleanName);
  const path = `group_names/${slug}`;
  try {
    const lockSnap = await getDoc(doc(db, 'group_names', slug));
    if (!lockSnap.exists()) return null;
    const lockData = lockSnap.data() as { groupCode?: string };
    if (!lockData?.groupCode) return null;
    return await getGroupFromFirebase(lockData.groupCode);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function getGroupMemberNamesFromFirebase(rawCode: string): Promise<string[]> {
  const code = sanitizeGroupCode(rawCode);
  const path = `groups/${code}/votes`;
  try {
    const snap = await getDocs(collection(db, 'groups', code, 'votes'));
    const names: string[] = [];
    snap.forEach(d => {
      const data = d.data() as RemoteVoteRecord;
      if (data.name) names.push(data.name.trim());
    });
    return names;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function registerGroupMemberInFirebase(
  rawCode: string,
  rawUid: string,
  memberName: string,
  votedGameIds: string[]
): Promise<void> {
  const code = sanitizeGroupCode(rawCode);
  const uid = sanitizeId(rawUid);
  const path = `groups/${code}/votes/${uid}`;
  try {
    await setDoc(doc(db, 'groups', code, 'votes', uid), {
      uid,
      name: memberName.trim().slice(0, 60),
      v: votedGameIds.slice(0, 3),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToGroupGames(
  rawCode: string,
  onUpdate: (games: GroupGameRecord[]) => void
): () => void {
  const code = sanitizeGroupCode(rawCode);
  const path = `groups/${code}/games`;
  try {
    return onSnapshot(
      collection(db, 'groups', code, 'games'),
      snapshot => {
        const list: GroupGameRecord[] = [];
        snapshot.forEach(docSnap => {
          list.push(docSnap.data() as GroupGameRecord);
        });
        list.sort((a, b) => (a.order || 0) - (b.order || 0));
        onUpdate(list);
      },
      error => {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function upsertGroupGameInFirebase(rawCode: string, game: GroupGameRecord): Promise<boolean> {
  const code = sanitizeGroupCode(rawCode);
  const clean = sanitizeGamePayload(game);
  const path = `groups/${code}/games/${clean.id}`;
  try {
    await setDoc(doc(db, 'groups', code, 'games', clean.id), clean);
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteGroupGameInFirebase(rawCode: string, rawGameId: string): Promise<boolean> {
  const code = sanitizeGroupCode(rawCode);
  const gameId = sanitizeId(rawGameId);
  const path = `groups/${code}/games/${gameId}`;
  try {
    await deleteDoc(doc(db, 'groups', code, 'games', gameId));
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function seedGroupGamesInFirebase(rawCode: string, gamesList: GroupGameRecord[]): Promise<boolean> {
  const code = sanitizeGroupCode(rawCode);
  const path = `groups/${code}/games`;
  try {
    const colRef = collection(db, 'groups', code, 'games');
    const existingSnap = await getDocs(colRef);
    const keepIds = new Set(gamesList.map(g => sanitizeId(g.id)));

    // Delete any removed games first, then batch-write clean games in chunks
    const ops: Array<{ type: 'set' | 'del'; id: string; data?: GroupGameRecord }> = [];
    existingSnap.forEach(d => {
      if (!keepIds.has(d.id)) ops.push({ type: 'del', id: d.id });
    });
    for (const g of gamesList) {
      const clean = sanitizeGamePayload(g);
      ops.push({ type: 'set', id: clean.id, data: clean });
    }

    for (let i = 0; i < ops.length; i += 200) {
      const batch = writeBatch(db);
      for (const op of ops.slice(i, i + 200)) {
        const ref = doc(db, 'groups', code, 'games', op.id);
        if (op.type === 'del') batch.delete(ref);
        else if (op.data) batch.set(ref, op.data);
      }
      await batch.commit();
    }
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToGroupVotes(
  rawCode: string,
  onUpdate: (summary: VoteSummary, totalVoters: number, memberNames: string[]) => void
): () => void {
  const code = sanitizeGroupCode(rawCode);
  const path = `groups/${code}/votes`;
  try {
    return onSnapshot(
      collection(db, 'groups', code, 'votes'),
      snapshot => {
        const summary: VoteSummary = {};
        const memberNames: string[] = [];
        let totalVoters = 0;

        snapshot.forEach(docSnap => {
          const data = docSnap.data() as RemoteVoteRecord;
          const userList = Array.isArray(data.v) ? data.v : [];
          const cleanName = (data.name || '').trim();
          if (cleanName && !memberNames.includes(cleanName)) memberNames.push(cleanName);
          if (userList.length > 0) totalVoters++;

          for (const gameId of userList) {
            if (!summary[gameId]) {
              summary[gameId] = { n: 0, uids: [], names: [] };
            }
            summary[gameId].n++;
            summary[gameId].uids.push(data.uid || docSnap.id);
            if (cleanName && !summary[gameId].names.includes(cleanName)) {
              summary[gameId].names.push(cleanName);
            }
          }
        });

        onUpdate(summary, totalVoters, memberNames);
      },
      error => {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function syncUserGroupVoteToFirebase(
  rawCode: string,
  rawUid: string,
  votedGameIds: string[],
  name: string
): Promise<boolean> {
  const code = sanitizeGroupCode(rawCode);
  const uid = sanitizeId(rawUid);
  const path = `groups/${code}/votes/${uid}`;
  try {
    await setDoc(doc(db, 'groups', code, 'votes', uid), {
      uid,
      name: (name || 'عضو').trim().slice(0, 60),
      v: votedGameIds.slice(0, 3),
      updatedAt: new Date().toISOString()
    });
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function resetGroupFirebaseVotes(rawCode: string): Promise<boolean> {
  const code = sanitizeGroupCode(rawCode);
  const path = `groups/${code}/votes`;
  try {
    const colRef = collection(db, 'groups', code, 'votes');
    const snapshot = await getDocs(colRef);
    const batch = writeBatch(db);
    snapshot.forEach(d => {
      const data = d.data() as RemoteVoteRecord;
      // Preserve member name registration while clearing their voted games
      batch.set(d.ref, {
        uid: data.uid || d.id,
        name: (data.name || 'عضو').slice(0, 60),
        v: [],
        updatedAt: new Date().toISOString()
      });
    });
    await batch.commit();
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// Cloudflare static hosting: admin authentication uses Firebase Auth, not a client password hash.
export async function isApprovedAdmin(user: { uid: string } | null | undefined): Promise<boolean> {
  if (!user) return false;
  try {
    const docSnap = await getDocFromServer(doc(db, 'admins', user.uid));
    return docSnap.exists() && docSnap.data()?.role === 'admin';
  } catch (error) {
    console.warn('Admin permissions could not be confirmed', error);
    return false;
  }
}
export async function loginApprovedAdmin(): Promise<boolean> {
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  return isApprovedAdmin(result.user);
}
export function observeAdminSession(callback: (approved: boolean) => void) {
  return onAuthStateChanged(auth, async user => callback(await isApprovedAdmin(user)));
}
export function logoutAdmin() { return signOut(auth); }

export type CatalogOverride<T> = { id: string; deleted?: boolean; game?: T };
export function subscribeToCatalogOverrides<T>(callback: (items: CatalogOverride<T>[]) => void) {
  return onSnapshot(collection(db, 'catalogOverrides'), snap => {
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() } as CatalogOverride<T>));
    callback(items);
  }, err => console.error('Catalog sync unavailable', err));
}
export async function publishCatalogGame<T extends { id: string }>(game: T) {
  if (!await isApprovedAdmin(auth.currentUser)) throw new Error('صلاحية المشرف غير مفعّلة');
  await setDoc(doc(db, 'catalogOverrides', game.id), {
    deleted: false, game, updatedAt: new Date().toISOString()
  });
}
export async function removeCatalogGame(id: string) {
  if (!await isApprovedAdmin(auth.currentUser)) throw new Error('صلاحية المشرف غير مفعّلة');
  await setDoc(doc(db, 'catalogOverrides', id), { deleted: true, updatedAt: new Date().toISOString() });
}
