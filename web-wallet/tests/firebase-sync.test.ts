import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  initializeTestEnvironment,
  assertFails,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  type Firestore,
} from "firebase/firestore";
import {
  TmpCashManager,
  type TmpCashOperation,
  type TmpCashProofRecord,
} from "coco-cashu-core/tmp-cash";
import {
  psRandomHex,
  psTokenAmount,
  decodePSToken,
} from "@cashu/cashu-ts/tmp-cash";
import {
  recoveryCodec,
  newProtection,
  type RecoveryCodec,
} from "../src/backup";
import { FirestoreWallet } from "../src/firestore-wallet";
import { SharedRepository } from "../src/shared-repository";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  "Firestore shared-wallet coordination",
  () => {
    let environment: RulesTestEnvironment;
    let fixture: ChildProcess;
    let mint: string;
    let codec: RecoveryCodec;
    beforeAll(async () => {
      environment = await initializeTestEnvironment({
        projectId: "demo-tmpcash",
        firestore: {
          rules: await readFile(
            new URL("../firestore.rules", import.meta.url),
            "utf8",
          ),
        },
      });
      codec = await recoveryCodec(
        newProtection("passphrase"),
        "a shared wallet recovery passphrase",
      );
      const port = await new Promise<number>((resolve) => {
        const socket = createServer();
        socket.listen(0, "127.0.0.1", () => {
          const address = socket.address();
          if (address && typeof address !== "string")
            socket.close(() => resolve(address.port));
        });
      });
      mint = `http://127.0.0.1:${port}`;
      fixture = spawn(
        "../.venv/bin/python",
        ["tests/fixture.py", "--port", String(port)],
        { stdio: "ignore" },
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if ((await fetch(mint + "/test/health")).ok) return;
        } catch {
          /* starting */
        }
        if (fixture.exitCode !== null) throw new Error("Mint fixture exited");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Mint fixture did not start");
    }, 30000);
    afterAll(async () => {
      fixture?.kill("SIGTERM");
      await environment?.cleanup();
    });
    beforeEach(async () => environment.clearFirestore());
    function connection(uid = "alice") {
      // RulesTestContext exposes the compatibility facade accepted by modular Firestore APIs.
      return environment
        .authenticatedContext(uid)
        .firestore() as unknown as Firestore;
    }
    function device(fetcher?: typeof fetch, db = connection(), uid = "alice") {
      const repo = new SharedRepository(
        new FirestoreWallet(db, uid),
        codec,
        mint,
      );
      return { db, repo, manager: new TmpCashManager(repo, mint, fetcher) };
    }
    async function fund(manager: TmpCashManager, amount = 64) {
      const funding = await manager.createFunding(amount);
      await fetch(mint + "/test/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_hash: funding.id }),
      });
      await manager.pollFunding(funding.id);
    }
    function swapOperation(
      manager: TmpCashManager,
      proofs: TmpCashProofRecord[],
    ) {
      return manager.wallet
        .prepareSwap({
          version: 3,
          mint,
          proofs: proofs.map((row) => row.proof),
        })
        .then(
          (payload): TmpCashOperation => ({
            id: payload.id,
            mint,
            payload,
            purpose: "send",
            amount: proofs.reduce((n, row) => n + row.proof.amount, 0),
            sendCount: payload.request.outputs.length,
            createdAt: Date.now(),
            error: null,
          }),
        );
    }
    it("permits one simultaneous spend from independent devices and preserves the full value", async () => {
      const a = device(),
        b = device();
      await a.repo.create();
      await Promise.all([a.manager.init(), b.manager.init()]);
      await fund(a.manager);
      const results = await Promise.allSettled([
        a.manager.send(64),
        b.manager.send(64),
      ]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(results.filter((row) => row.status === "rejected")).toHaveLength(
        1,
      );
      await b.repo.synchronize();
      const state = await b.repo.read();
      expect(state.operations).toHaveLength(0);
      expect(
        state.activity.filter((row) => row.purpose === "send"),
      ).toHaveLength(1);
      expect(
        state.proofs
          .filter((row) => row.state === "sent")
          .reduce((n, row) => n + row.proof.amount, 0),
      ).toBe(64);
      expect(state.proofs.filter((row) => row.state === "ready")).toHaveLength(
        0,
      );
      expect((await a.repo.store.read())!.backup).not.toContain("credential");
    });
    it("recovers a lost swap response on two new devices using the exact saved request, finalizing once", async () => {
      const a = device(async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith("/v1/swap"))
          throw new Error("response lost");
        return response;
      });
      await a.repo.create();
      await a.manager.init();
      await fund(a.manager);
      await expect(a.manager.send(32)).rejects.toThrow("response lost");
      const op = (await a.repo.read()).operations[0];
      expect(op.payload.secrets.length).toBeGreaterThan(0);
      const bodies: string[] = [];
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const retry: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith("/v1/swap")) {
          bodies.push(String(init?.body));
          if (bodies.length === 2) resume();
          await gate;
        }
        return response;
      };
      const b = device(retry),
        c = device(retry);
      await Promise.all([b.manager.init(), c.manager.init()]);
      const results = await Promise.all([
        b.manager.retry(op.id),
        c.manager.retry(op.id),
      ]);
      expect(bodies).toEqual([
        JSON.stringify(op.payload.request),
        JSON.stringify(op.payload.request),
      ]);
      expect(results[0].token).toBe(results[1].token);
      expect(psTokenAmount(decodePSToken(results[0].token!))).toBe(32);
      await b.repo.synchronize();
      const state = await b.repo.read();
      expect(state.operations).toHaveLength(0);
      expect(state.activity.filter((row) => row.id === op.id)).toHaveLength(1);
      expect(
        state.proofs
          .filter((row) => row.state === "ready")
          .reduce((n, row) => n + row.proof.amount, 0),
      ).toBe(32);
    }, 30000);
    it("does not submit a spending request when the reservation cannot be committed", async () => {
      let posts = 0;
      const a = device(async (input, init) => {
        if (String(input).endsWith("/v1/swap")) posts++;
        return fetch(input, init);
      });
      await a.repo.create();
      await a.manager.init();
      await fund(a.manager);
      const unavailable = vi
        .spyOn(a.repo.store, "update")
        .mockRejectedValueOnce(new Error("Firestore is offline"));
      await expect(a.manager.send(64)).rejects.toThrow("offline");
      unavailable.mockRestore();
      expect(posts).toBe(0);
      await a.repo.synchronize();
      expect(
        (await a.repo.read()).proofs.filter((row) => row.state === "ready"),
      ).toHaveLength(1);
    });
    it("receives a copied incoming token on only one of two devices", async () => {
      const sender = device(undefined, connection("sender"), "sender");
      await sender.repo.create();
      await sender.manager.init();
      await fund(sender.manager, 32);
      const token = await sender.manager.send(32);
      const a = device(),
        b = device();
      await a.repo.create();
      await Promise.all([a.manager.init(), b.manager.init()]);
      const results = await Promise.allSettled([
        a.manager.receive(token),
        b.manager.receive(token),
      ]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(
        1,
      );
      await b.repo.synchronize();
      const state = await b.repo.read();
      expect(state.operations).toHaveLength(0);
      expect(
        state.proofs
          .filter((row) => row.state === "ready")
          .reduce((n, row) => n + row.proof.amount, 0),
      ).toBe(32);
    });
    it("recovers a paid melt's lost response on a second device, including fee change", async () => {
      const a = device(async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith("/v1/melt/bolt11"))
          throw new Error("payment response lost");
        return response;
      });
      await a.repo.create();
      await a.manager.init();
      await fund(a.manager, 100);
      const invoice = await (
        await fetch(mint + "/test/receiver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: 10 }),
        })
      ).json();
      await expect(
        a.manager.melt(await a.manager.meltQuote(invoice.request)),
      ).rejects.toThrow("payment response lost");
      const op = (await a.repo.read()).operations[0];
      const b = device();
      await b.manager.init();
      const activity = await b.manager.retry(op.id);
      expect(activity.receipt?.amount).toBe(10);
      expect((await b.manager.view()).balance).toBe(88);
      expect((await b.repo.read()).operations).toHaveLength(0);
    });
    it("keeps nonterminal rejections reserved until another device resolves the saved melt", async () => {
      const a = device(async (input, init) => {
        if (String(input).endsWith("/v1/melt/bolt11"))
          return new Response(
            JSON.stringify({
              detail:
                "backing HTLC is too close to its settlement cutoff for a new melt",
            }),
            { status: 409 },
          );
        return fetch(input, init);
      });
      await a.repo.create();
      await a.manager.init();
      await fund(a.manager, 100);
      const invoice = await (
        await fetch(mint + "/test/receiver", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: 10 }),
        })
      ).json();
      await expect(
        a.manager.melt(await a.manager.meltQuote(invoice.request)),
      ).rejects.toThrow("cutoff");
      const state = await a.repo.read();
      expect(state.operations).toHaveLength(1);
      expect(state.proofs.some((row) => row.state === "reserved")).toBe(true);
      const b = device();
      await b.manager.init();
      await b.manager.retry(state.operations[0].id);
      expect((await b.repo.read()).operations).toHaveLength(0);
      expect((await b.manager.view()).balance).toBe(88);
    });
    it("rolls back a conflicting batch and ignores stale proof observations", async () => {
      const a = device(),
        b = device();
      await a.repo.create();
      await a.manager.init();
      await fund(a.manager, 64);
      await fund(a.manager, 32);
      await b.manager.init();
      const proofs = (await a.repo.read()).proofs.filter(
        (row) => row.state === "ready",
      );
      const first = await swapOperation(a.manager, [proofs[0]]);
      const second = await swapOperation(a.manager, [proofs[1]]);
      await b.repo.reserve(second, [proofs[1]]);
      const conflicting = await swapOperation(a.manager, [proofs[1]]);
      await expect(
        a.repo.reserveMany([
          { operation: first, inputs: [proofs[0]] },
          { operation: conflicting, inputs: [proofs[1]] },
        ]),
      ).rejects.toThrow("reserved");
      await a.repo.updateProofStates([{ id: proofs[1].id, state: "expired" }]);
      await a.repo.synchronize();
      const state = await a.repo.read();
      expect(state.operations.map((row) => row.id)).toEqual([second.id]);
      expect(state.proofs.find((row) => row.id === proofs[0].id)!.state).toBe(
        "ready",
      );
      expect(state.proofs.find((row) => row.id === proofs[1].id)!.state).toBe(
        "reserved",
      );
    });
    it("enforces account isolation, immutable protection, monotonic revisions, and atomic chunk updates", async () => {
      const a = device();
      await a.repo.create();
      const root = doc(a.db, "wallets", "alice");
      const manifest = (await getDoc(root)).data()!;
      await assertFails(getDoc(doc(connection("bob"), "wallets", "alice")));
      await assertFails(
        getDoc(
          doc(
            environment
              .unauthenticatedContext()
              .firestore() as unknown as Firestore,
            "wallets",
            "alice",
          ),
        ),
      );
      await assertFails(
        setDoc(root, { ...manifest, updatedAt: serverTimestamp() }),
      );
      await assertFails(
        updateDoc(root, {
          revision: 2,
          protection: { mode: "plaintext" },
          updatedAt: serverTimestamp(),
        }),
      );
      await assertFails(
        setDoc(doc(a.db, "wallets", "alice", "chunks", "0"), {
          revision: 1,
          data: "tampered",
        }),
      );
      const wrong = new SharedRepository(
        a.repo.store,
        await recoveryCodec(
          codec.protection,
          "a different incorrect passphrase",
        ),
        mint,
      );
      await expect(wrong.synchronize()).rejects.toThrow("Incorrect password");
      expect((await getDoc(root)).data()!.revision).toBe(1);
    });
    it("round trips multiple chunks and cleans up smaller snapshots atomically", async () => {
      const store = new FirestoreWallet(connection("large"), "large");
      const large = JSON.stringify({ text: "ü".repeat(100_000) });
      const saved = await store.update(async () => ({
        protection: { mode: "plaintext" },
        backup: large,
      }));
      expect(JSON.parse(saved.backup)).toEqual(JSON.parse(large));
      expect(JSON.parse((await store.read())!.backup)).toEqual(
        JSON.parse(large),
      );
      await store.update(async () => ({
        protection: { mode: "plaintext" },
        backup: "{}",
      }));
      expect((await store.read())!.backup).toBe("{}");
    });
  },
);
