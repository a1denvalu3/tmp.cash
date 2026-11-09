import { initializeApp, getApps } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  type User,
} from "firebase/auth";
import { firebaseConfig, googleConfigured } from "./google-config";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

export function googleApp() {
  if (!googleConfigured)
    throw new Error("Google recovery is unavailable on this deployment");
  return (
    getApps().find((app) => app.name === "tmp.cash") ??
    initializeApp(firebaseConfig, "tmp.cash")
  );
}
export function observeGoogleUser(callback: (user: User | null) => void) {
  return onAuthStateChanged(getAuth(googleApp()), callback);
}
export async function connectGoogle() {
  const provider = new GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  provider.setCustomParameters({ prompt: "select_account" });
  const result = await signInWithPopup(getAuth(googleApp()), provider);
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  if (!token) throw new Error("Google Drive authorization was not granted");
  return { user: result.user, token };
}
export async function disconnectGoogle() {
  await signOut(getAuth(googleApp()));
}
