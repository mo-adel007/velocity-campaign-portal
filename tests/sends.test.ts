/**
 * Send guarantees, tested against the live project without calling the
 * provider (AC1.4, AC3.8, AC3.9, AC3.10, AC3.12, AC3.13, AC3.14 recording side).
 *
 * Approvals are made through the public API by throwaway owners, with
 * dispatch paused (a lease that expires by itself) so the real worker can never
 * send them. The worker steps (late unsubscribe, retry after a lost response,
 * recording results) run inside a rolled-back transaction, so real contacts
 * are never changed. Afterwards the sends created by the test users are
 * removed; that needs the immutability triggers switched off for the cleanup
 * transaction only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLive, liveConfigured, type Live, type Member } from "./live";

describe.skipIf(!liveConfigured)("sends (live project)", { timeout: 120_000 }, () => {
  let live: Live;
  let owner: Member;
  let analyst: Member;
  let otherBrandOwner: Member;
  let campaignId: number;
  let smsCampaignId: number;

  const audience = async (brandId: string, campaign: number) =>
    (
      await live.db.query(
        `select count(distinct c.email)::int addresses, count(*)::int customers
         from public.contacts c, public.campaigns k
         where k.id = $2 and c.brand_id = $1
           and public.contact_block_reason(c) is null
           and (k.target_country is null or c.country = k.target_country)`,
        [brandId, campaign],
      )
    ).rows[0] as { addresses: number; customers: number };

  beforeAll(async () => {
    live = await connectLive("sends");
    await live.db.query("select public.pause_dispatch(10, 'live send tests')");
    owner = await live.createMember("KAROO", "owner");
    analyst = await live.createMember("KAROO", "analyst");
    otherBrandOwner = await live.createMember("MARRAKECH", "owner");
    const campaign = async (externalId: string) =>
      // pg returns bigint as a string; the API returns numbers.
      Number((await live.db.query("select id from public.campaigns where brand_id = $1 and external_id = $2", [owner.brand.id, externalId])).rows[0].id);
    campaignId = await campaign("KAR-0002"); // email, whole-brand audience of ~330 addresses → 2 chunks
    smsCampaignId = await campaign("KAR-0001");
  });

  afterAll(async () => {
    if (!live) return;
    const ids = [owner, analyst, otherBrandOwner].filter(Boolean).map((m) => m.userId);
    await live.db.query("begin");
    for (const t of ["send_recipients", "send_chunks", "sends"]) await live.db.query(`alter table public.${t} disable trigger user`);
    await live.db.query("delete from public.send_recipients where send_id in (select id from public.sends where approved_by = any ($1))", [ids]);
    await live.db.query("delete from public.send_chunks where send_id in (select id from public.sends where approved_by = any ($1))", [ids]);
    await live.db.query("delete from public.sends where approved_by = any ($1)", [ids]);
    for (const t of ["send_recipients", "send_chunks", "sends"]) await live.db.query(`alter table public.${t} enable trigger user`);
    await live.db.query("commit");
    await live.db.query("select public.pause_dispatch(0, null)");
    await live.close();
  });

  it("analysts get no send controls and are refused directly (AC1.4)", async () => {
    const preview = await analyst.client.rpc("preview_send", { p_campaign_id: campaignId });
    expect(preview.error?.code).toBe("42501");
    const approve = await analyst.client.rpc("approve_send", { p_campaign_id: campaignId, p_expected_addresses: 1 });
    expect(approve.error?.code).toBe("42501");
    const worker = await analyst.client.rpc("claim_send_chunk");
    expect(worker.error).not.toBeNull();
  });

  it("an owner cannot preview or send another brand's campaign", async () => {
    const preview = await otherBrandOwner.client.rpc("preview_send", { p_campaign_id: campaignId });
    expect(preview.error?.code).toBe("VC404");
    const approve = await otherBrandOwner.client.rpc("approve_send", { p_campaign_id: campaignId, p_expected_addresses: 1 });
    expect(approve.error?.code).toBe("VC404");
  });

  it("SMS campaigns say why they cannot be sent and are refused (AC3.2, AC3.13)", async () => {
    const overview = await owner.client.rpc("campaigns_overview");
    expect(overview.error).toBeNull();
    const sms = overview.data.find((c: { campaign_id: number }) => c.campaign_id === smsCampaignId);
    expect(sms).toMatchObject({ channel: "sms", sendable: false });
    expect(sms.not_sendable_reason).toMatch(/SMS/);

    const approve = await owner.client.rpc("approve_send", { p_campaign_id: smsCampaignId, p_expected_addresses: 1 });
    expect(approve.error?.code).toBe("VC422");
  });

  it("the preview shows the audience rule and N customers → M addresses (AC3.8)", async () => {
    const { data, error } = await owner.client.rpc("preview_send", { p_campaign_id: campaignId });
    expect(error).toBeNull();
    const truth = await audience(owner.brand.id, campaignId);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ channel: "email", sendable: true, customers: truth.customers, addresses: truth.addresses });
    expect(data[0].audience_rule).toMatch(/Contactable by email/);

    const page = await owner.client.rpc("preview_send_recipients", { p_campaign_id: campaignId, p_limit: 1000 });
    expect(page.error).toBeNull();
    expect(page.data).toHaveLength(truth.addresses);
    expect(page.data.reduce((s: number, r: { customers: number }) => s + r.customers, 0)).toBe(truth.customers);
  });

  it("a confirm against a stale preview creates nothing", async () => {
    const truth = await audience(owner.brand.id, campaignId);
    const approve = await owner.client.rpc("approve_send", { p_campaign_id: campaignId, p_expected_addresses: truth.addresses + 1 });
    expect(approve.error?.code).toBe("VC422");
    const { rows } = await live.db.query("select count(*)::int n from public.sends where approved_by = $1", [owner.userId]);
    expect(rows[0].n).toBe(0);
  });

  it("two confirms at once from two sessions create exactly one send (AC3.10)", async () => {
    const truth = await audience(owner.brand.id, campaignId);
    const second = live.newClient();
    const signIn = await second.auth.signInWithPassword({ email: owner.email, password: owner.password });
    expect(signIn.error).toBeNull();

    const args = { p_campaign_id: campaignId, p_expected_addresses: truth.addresses };
    const results = await Promise.all([owner.client.rpc("approve_send", args), second.rpc("approve_send", args)]);
    const ok = results.filter((r) => !r.error);
    const refused = results.filter((r) => r.error);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].error!.code).toBe("VC409");
    expect(refused[0].error!.message).toMatch(/already in progress/);

    const { rows } = await live.db.query("select count(*)::int n from public.sends where approved_by = $1", [owner.userId]);
    expect(rows[0].n).toBe(1);
  });

  it("the approval records who, when, the rule and a frozen, deduplicated snapshot (AC3.9)", async () => {
    const truth = await audience(owner.brand.id, campaignId);
    const { data: sends, error } = await owner.client.from("sends").select("*").eq("campaign_id", campaignId);
    expect(error).toBeNull();
    expect(sends).toHaveLength(1);
    const send = sends![0];
    expect(send).toMatchObject({
      approved_by: owner.userId,
      approved_by_email: owner.email,
      customers_count: truth.customers,
      addresses_count: truth.addresses,
      status: "dispatching",
    });

    const { rows } = await live.db.query(
      `select count(*)::int recipients, count(distinct email)::int emails, sum(cardinality(contact_ids))::int customers,
         count(distinct chunk_no)::int chunks, (select count(*)::int from public.send_chunks where send_id = $1) chunk_rows
       from public.send_recipients where send_id = $1`,
      [send.id],
    );
    expect(rows[0]).toEqual({
      recipients: truth.addresses,
      emails: truth.addresses,
      customers: truth.customers,
      chunks: Math.ceil(truth.addresses / send.chunk_size),
      chunk_rows: Math.ceil(truth.addresses / send.chunk_size),
    });
  });

  it("nobody can change or delete an approval, not even the service role (AC3.9)", async () => {
    const { data: send } = await live.admin.from("sends").select("id").eq("campaign_id", campaignId).single();
    const edit = await live.admin.from("sends").update({ addresses_count: 1 }).eq("id", send!.id);
    expect(edit.error?.code).toBe("VC403");
    const remove = await live.admin.from("sends").delete().eq("id", send!.id);
    expect(remove.error?.code).toBe("VC403");
    const recipient = await live.admin.from("send_recipients").update({ email: "someone-else@example.com" }).eq("send_id", send!.id);
    expect(recipient.error?.code).toBe("VC403");
    const owners = await owner.client.from("sends").update({ addresses_count: 1 }).eq("id", send!.id).select("id");
    expect(owners.error).not.toBeNull();
  });

  it("a campaign with a send in flight is refused and shown as in progress (AC3.13)", async () => {
    const truth = await audience(owner.brand.id, campaignId);
    const approve = await owner.client.rpc("approve_send", { p_campaign_id: campaignId, p_expected_addresses: truth.addresses });
    expect(approve.error?.code).toBe("VC409");
    const { data } = await owner.client.rpc("campaigns_overview");
    const row = data.find((c: { campaign_id: number }) => c.campaign_id === campaignId);
    expect(row.sendable).toBe(false);
    expect(row.in_flight_send_id).not.toBeNull();
    expect(row.last_sent_at).not.toBeNull();
  });

  it("late unsubscribes are suppressed once, retries resend the same list, results record once (AC3.11, AC3.12, AC3.14)", async () => {
    const { db } = live;
    const { rows: [send] } = await db.query("select * from public.sends where campaign_id = $1 and approved_by = $2", [campaignId, owner.userId]);
    const recipientsOf = async (chunk: number) =>
      (await db.query("select * from public.send_recipients where send_id = $1 and chunk_no = $2 order by recipient_id", [send.id, chunk])).rows;

    await db.query("begin");
    try {
      // Paused claims return nothing.
      expect((await db.query("select public.claim_send_chunk() as c")).rows[0].c).toBeNull();
      // In the rolled-back world: dispatch runs, and nothing else is queued ahead of this send.
      await db.query("update private.dispatch_control set paused_until = null");
      await db.query("update public.send_chunks set status = 'sending', locked_at = now() where send_id <> $1 and status in ('pending', 'sending')", [send.id]);

      const before = await recipientsOf(0);
      const [late, alsoLate] = before;
      const unsubscribe = (contactId: number, n: number) =>
        db.query(
          `insert into public.engagement_events (brand_id, source, event_id, contact_id, campaign_id, type, channel, occurred_at)
           values ($1, 'provider', $2, $3, $4, 'unsubscribe', 'email', now())`,
          [owner.brand.id, `test-late-${send.id}-${n}`, contactId, campaignId],
        );
      await unsubscribe(late.contact_ids[0], 1);

      const first = (await db.query("select public.claim_send_chunk() as c")).rows[0].c;
      expect(first).toMatchObject({ send_id: send.id, chunk_no: 0, attempt: 1, idempotency_key: `${send.id}:0` });
      const firstIds = first.recipients.map((r: { recipient_id: string }) => r.recipient_id);
      expect(firstIds).not.toContain(late.recipient_id);
      expect(firstIds).toHaveLength(before.length - 1);
      const suppressed = (await recipientsOf(0)).find((r) => r.id === late.id);
      expect(suppressed).toMatchObject({ status: "suppressed", reason: "Became ineligible after approval: unsubscribed" });

      // The worker dies after calling the provider. Meanwhile another recipient unsubscribes.
      // The retry must carry exactly the same list, because the provider replays the key's first response.
      await unsubscribe(alsoLate.contact_ids[0], 2);
      await db.query("update public.send_chunks set locked_at = now() - interval '4 minutes' where send_id = $1 and chunk_no = 0", [send.id]);
      const retry = (await db.query("select public.claim_send_chunk() as c")).rows[0].c;
      expect(retry).toMatchObject({ send_id: send.id, chunk_no: 0, attempt: 2, idempotency_key: first.idempotency_key });
      expect(retry.recipients).toEqual(first.recipients);

      // Results must cover every pending recipient.
      await db.query("savepoint partial");
      await expect(
        db.query("select public.record_send_chunk($1, 0, 'batch_test', $2)", [send.id, JSON.stringify([{ recipient_id: firstIds[0], status: "sent" }])]),
      ).rejects.toMatchObject({ code: "VC422" });
      await db.query("rollback to savepoint partial");

      const results = firstIds.map((id: string, i: number) =>
        i === 1 ? { recipient_id: id, status: "failed", reason: "mailbox does not exist" } : { recipient_id: id, status: "sent" },
      );
      await db.query("select public.record_send_chunk($1, 0, 'batch_test', $2)", [send.id, JSON.stringify(results)]);
      await db.query("select public.record_send_chunk($1, 0, 'batch_test', $2)", [send.id, JSON.stringify(results)]);

      const after = await recipientsOf(0);
      expect(after.filter((r) => r.status === "sent")).toHaveLength(firstIds.length - 1);
      expect(after.find((r) => r.recipient_id === firstIds[1])).toMatchObject({ status: "failed", reason: "mailbox does not exist" });
      expect(after.filter((r) => r.status === "suppressed")).toHaveLength(1);
      const { rows: [chunk] } = await db.query("select * from public.send_chunks where send_id = $1 and chunk_no = 0", [send.id]);
      expect(chunk).toMatchObject({ status: "sent", batch_id: "batch_test", attempts: 2 });

      const { rows: [unchanged] } = await db.query("select customers_count, addresses_count from public.sends where id = $1", [send.id]);
      expect(unchanged).toEqual({ customers_count: send.customers_count, addresses_count: send.addresses_count });
    } finally {
      await db.query("rollback");
    }
  });
});
