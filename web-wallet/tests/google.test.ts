import { beforeEach, afterEach, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  popup: vi.fn(),
  credential: vi.fn(),
  signOut: vi.fn(),
  observe: vi.fn(),
  addScope: vi.fn(),
  parameters: vi.fn(),
}));
vi.mock("firebase/app", () => ({
  initializeApp: vi.fn(() => ({ name: "tmp.cash" })),
  getApps: () => [],
}));
vi.mock("firebase/auth", () => {
  class GoogleAuthProvider {
    addScope = mocks.addScope;
    setCustomParameters = mocks.parameters;
    static credentialFromResult = mocks.credential;
  }
  return {
    getAuth: () => "auth",
    GoogleAuthProvider,
    signInWithPopup: mocks.popup,
    signOut: mocks.signOut,
    onAuthStateChanged: mocks.observe,
  };
});
beforeEach(() => {
  vi.resetModules();
  for (const key of ["API_KEY", "AUTH_DOMAIN", "PROJECT_ID", "APP_ID"])
    vi.stubEnv("VITE_FIREBASE_" + key, "public-configuration");
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());
it("requests the restricted Drive app-data scope and requires a Google access token", async () => {
  const { connectGoogle, observeGoogleUser, disconnectGoogle, DRIVE_SCOPE } =
    await import("../src/google");
  mocks.popup.mockResolvedValue({ user: { uid: "alice" } });
  mocks.credential.mockReturnValue({ accessToken: "session-only" });
  expect(await connectGoogle()).toEqual({
    user: { uid: "alice" },
    token: "session-only",
  });
  expect(mocks.addScope).toHaveBeenCalledWith(DRIVE_SCOPE);
  expect(mocks.parameters).toHaveBeenCalledWith({ prompt: "select_account" });
  const listener = vi.fn();
  observeGoogleUser(listener);
  expect(mocks.observe).toHaveBeenCalledWith("auth", listener);
  await disconnectGoogle();
  expect(mocks.signOut).toHaveBeenCalledWith("auth");
  mocks.credential.mockReturnValue(null);
  await expect(connectGoogle()).rejects.toThrow(
    "authorization was not granted",
  );
});
it("keeps Google recovery disabled when configuration is incomplete", async () => {
  vi.stubEnv("VITE_FIREBASE_API_KEY", "");
  const { googleApp } = await import("../src/google");
  expect(googleApp).toThrow("unavailable");
  expect(mocks.popup).not.toHaveBeenCalled();
});
