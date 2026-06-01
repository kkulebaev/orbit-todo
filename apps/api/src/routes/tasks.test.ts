/**
 * Integration tests for /v1/tasks routes.
 *
 * Each `describe` block runs against a dedicated PostgreSQL testcontainer so
 * DB state is fully isolated from other test files. Rows are wiped in
 * `beforeEach` to isolate individual tests within this file.
 */

import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
} from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../server.js";
import {
  startTestDb,
  stopTestDb,
  type TestDb,
} from "../test-helpers/postgres.js";
import { createTestPat } from "../test-helpers/pat.js";

describe("tasks routes", () => {
  let db: TestDb;
  let app: ReturnType<typeof createApp>;
  /** Bot-PAT plaintext for impersonation-style auth (canImpersonate=true). */
  let botPat: string;

  beforeAll(async () => {
    db = await startTestDb();
    app = createApp({
      prisma: db.prisma,
      allowedCidrs: ["fd00::/8", "::1", "127.0.0.1/32"],
      publicExposure: true,
    });
  }, 120_000);

  afterAll(async () => {
    await stopTestDb(db);
  });

  beforeEach(async () => {
    // Delete in FK-safe order: child tables first.
    await db.prisma.pendingAction.deleteMany();
    await db.prisma.task.deleteMany();
    await db.prisma.personalAccessToken.deleteMany();
    await db.prisma.user.deleteMany();

    // Mint a fresh bot PAT per test. canImpersonate=true so the
    // X-Telegram-User-Id header is honored (matches bot-on-behalf-of-user
    // request shape, same semantics as the pre-P2 service-token + header).
    const fixture = await createTestPat(db.prisma, {
      canImpersonate: true,
      label: "test-bot",
    });
    botPat = fixture.plaintext;
  });

  /** Build standard auth headers for a given Telegram user id. */
  function authHeaders(
    telegramUserId: string,
    extra?: Record<string, string>,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${botPat}`,
      "X-Telegram-User-Id": telegramUserId,
      ...extra,
    };
  }

  // ---------------------------------------------------------------------------
  // Basic CRUD
  // ---------------------------------------------------------------------------

  it("GET /v1/tasks — returns empty list when user has no tasks", async () => {
    const res = await request(app)
      .get("/v1/tasks")
      .set(authHeaders("100"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], page: 0, total: 0 });
  });

  it("POST /v1/tasks — creates a task and returns TaskDto (201)", async () => {
    const res = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("101"))
      .send({ title: "Buy groceries" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "Buy groceries",
      status: "open",
      numId: expect.any(Number),
      createdAt: expect.any(String),
      doneAt: null,
      dueAt: null,
      dueHasTime: false,
    });
  });

  it("GET /v1/tasks/:numId — 200 for the owner", async () => {
    const created = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("200"))
      .send({ title: "My task" });
    expect(created.status).toBe(201);
    const { numId } = created.body as { numId: number };

    const res = await request(app)
      .get(`/v1/tasks/${numId}`)
      .set(authHeaders("200"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ numId, title: "My task" });
  });

  it("PATCH /v1/tasks/:numId — updates title for the owner", async () => {
    const created = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("201"))
      .send({ title: "Old title" });
    const { numId } = created.body as { numId: number };

    const res = await request(app)
      .patch(`/v1/tasks/${numId}`)
      .set(authHeaders("201"))
      .send({ title: "New title" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ numId, title: "New title" });
  });

  it("DELETE /v1/tasks/:numId — 204 for the owner", async () => {
    const created = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("202"))
      .send({ title: "To remove" });
    const { numId } = created.body as { numId: number };

    const del = await request(app)
      .delete(`/v1/tasks/${numId}`)
      .set(authHeaders("202"));
    expect(del.status).toBe(204);

    // Confirm it's gone
    const get = await request(app)
      .get(`/v1/tasks/${numId}`)
      .set(authHeaders("202"));
    expect(get.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Owner-check (AC-4, AC-5): mismatch always yields 404, never 403
  // ---------------------------------------------------------------------------

  it("GET /v1/tasks/:numId — 404 for a different user (owner-check)", async () => {
    const created = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("300"))
      .send({ title: "User A task" });
    const { numId } = created.body as { numId: number };

    const res = await request(app)
      .get(`/v1/tasks/${numId}`)
      .set(authHeaders("301")); // User B
    expect(res.status).toBe(404);
  });

  it("PATCH /v1/tasks/:numId — 404 for a different user", async () => {
    const created = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("400"))
      .send({ title: "Locked" });
    const { numId } = created.body as { numId: number };

    const res = await request(app)
      .patch(`/v1/tasks/${numId}`)
      .set(authHeaders("401"))
      .send({ title: "Hijacked" });
    expect(res.status).toBe(404);
  });

  it("DELETE /v1/tasks/:numId — 404 for a different user", async () => {
    const created = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("500"))
      .send({ title: "Protected" });
    const { numId } = created.body as { numId: number };

    const res = await request(app)
      .delete(`/v1/tasks/${numId}`)
      .set(authHeaders("501"));
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Cascade delete (AC-22): deleting a Task removes its PendingAction rows
  // ---------------------------------------------------------------------------

  it("DELETE /v1/tasks/:numId — cascades to linked PendingAction rows", async () => {
    const created = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("600"))
      .send({ title: "Will cascade" });
    expect(created.status).toBe(201);
    const { numId } = created.body as { numId: number };

    const task = await db.prisma.task.findUnique({ where: { numId } });
    expect(task).not.toBeNull();

    // Create a PendingAction referencing this task directly via Prisma.
    // (The POST /v1/sessions API doesn't expose taskId; the bot sets it.)
    await db.prisma.pendingAction.create({
      data: {
        kind: "editTitle",
        userId: task!.ownerId,
        taskId: task!.id,
      },
    });
    expect(
      await db.prisma.pendingAction.count({ where: { taskId: task!.id } }),
    ).toBe(1);

    const del = await request(app)
      .delete(`/v1/tasks/${numId}`)
      .set(authHeaders("600"));
    expect(del.status).toBe(204);

    // PendingAction should be gone via ON DELETE CASCADE.
    expect(
      await db.prisma.pendingAction.count({ where: { taskId: task!.id } }),
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Idempotency (AC-6): duplicate POST with same Idempotency-Key = one DB write
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // GET /v1/tasks?mode=my — two-group ordering:
  //   group 1 = dueAt < now+7d (overdue + this week) by dueAt ASC,
  //   group 2 = no dueAt OR dueAt >= now+7d by createdAt DESC.
  // ---------------------------------------------------------------------------

  it("GET /v1/tasks?mode=my — groups urgent (overdue + ≤7d) first by dueAt ASC, then the rest by createdAt DESC", async () => {
    const tg = "800";

    // Establish a stable createdAt ordering for the "rest" group by creating
    // them in sequence: noDueOld, then noDueNew → expect [noDueNew, noDueOld].
    const noDueOld = await request(app)
      .post("/v1/tasks")
      .set(authHeaders(tg))
      .send({ title: "no-due old" });
    const noDueNew = await request(app)
      .post("/v1/tasks")
      .set(authHeaders(tg))
      .send({ title: "no-due new" });

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Urgent group (dueAt < now+7d), should sort ASC: overdue → today → +3d.
    const overdue = await request(app)
      .post("/v1/tasks")
      .set(authHeaders(tg))
      .send({
        title: "overdue",
        dueAt: new Date(now - 2 * day).toISOString(),
      });
    const today = await request(app)
      .post("/v1/tasks")
      .set(authHeaders(tg))
      .send({
        title: "today",
        dueAt: new Date(now + 60 * 1000).toISOString(),
      });
    const inThreeDays = await request(app)
      .post("/v1/tasks")
      .set(authHeaders(tg))
      .send({
        title: "in 3 days",
        dueAt: new Date(now + 3 * day).toISOString(),
      });
    // Rest group: dueAt strictly beyond the 7-day cutoff.
    const inTenDays = await request(app)
      .post("/v1/tasks")
      .set(authHeaders(tg))
      .send({
        title: "in 10 days",
        dueAt: new Date(now + 10 * day).toISOString(),
      });

    const list = await request(app)
      .get("/v1/tasks?mode=my")
      .set(authHeaders(tg));
    expect(list.status).toBe(200);
    const items = (list.body as { items: { numId: number }[] }).items;
    expect(items.map((t) => t.numId)).toEqual([
      overdue.body.numId,
      today.body.numId,
      inThreeDays.body.numId,
      // Rest group: createdAt DESC — inTenDays was created after the no-due
      // pair, then noDueNew, then noDueOld.
      inTenDays.body.numId,
      noDueNew.body.numId,
      noDueOld.body.numId,
    ]);
    expect(list.body.total).toBe(6);
  });

  it("GET /v1/tasks?mode=my — pagination spans the group boundary correctly", async () => {
    const tg = "801";
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // 1 urgent + 1 no-due => with PAGE_SIZE=12, page=0 returns both in
    // [urgent, no-due] order; page=1 is empty; total=2.
    const urgent = await request(app)
      .post("/v1/tasks")
      .set(authHeaders(tg))
      .send({
        title: "urgent",
        dueAt: new Date(now + 1 * day).toISOString(),
      });
    const rest = await request(app)
      .post("/v1/tasks")
      .set(authHeaders(tg))
      .send({ title: "no due" });

    const page0 = await request(app)
      .get("/v1/tasks?mode=my&page=0")
      .set(authHeaders(tg));
    expect(page0.status).toBe(200);
    expect(
      (page0.body as { items: { numId: number }[] }).items.map((t) => t.numId),
    ).toEqual([urgent.body.numId, rest.body.numId]);
    expect(page0.body.total).toBe(2);

    const page1 = await request(app)
      .get("/v1/tasks?mode=my&page=1")
      .set(authHeaders(tg));
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({ items: [], page: 1, total: 2 });
  });

  it("POST /v1/tasks — duplicate Idempotency-Key returns cached 201, only one row written", async () => {
    const idempotencyKey = randomUUID();

    const first = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("700", { "Idempotency-Key": idempotencyKey }))
      .send({ title: "Idempotent" });
    expect(first.status).toBe(201);

    // Second call: same key, intentionally different body.
    const second = await request(app)
      .post("/v1/tasks")
      .set(authHeaders("700", { "Idempotency-Key": idempotencyKey }))
      .send({ title: "Should be ignored" });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body); // identical cached response

    // Exactly one task persisted in DB.
    const count = await db.prisma.task.count();
    expect(count).toBe(1);
  });
});
