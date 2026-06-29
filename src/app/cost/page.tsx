"use client";

/**
 * /cost — what the PLATFORM costs to run. Two separate stories, never multiplied
 * together:
 *   1. Capacity (the ceiling): up to 5,000 concurrent coding sessions, unlimited
 *      developers, auto-scaling microVMs that cost $0 when idle.
 *   2. Cost (infrastructure only): the monthly AWS bill to host Ember — App
 *      Runner + AgentCore compute + DynamoDB + S3 + EFS + Cognito. NO LLM /
 *      token cost. Inference runs on Bedrock out of the box, or on your own
 *      Claude/Codex plan — billed by that provider, never through Ember.
 *
 * Rates are the public AWS numbers (us-east-1, verified 2026-06) in RATES so
 * they're easy to update when prices move.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

// ─── Rates (USD, us-east-1). Update here when AWS pricing changes. ─────────────
const RATES = {
  // The architecture's delivered ceiling — concurrent AgentCore microVMs.
  capacity: { concurrentSessions: 5000 },
  // AWS App Runner (always-on web/control plane), 1 vCPU / 2 GB. Memory is billed
  // for the provisioned instance; vCPU only bills while serving requests, so we
  // apply a request duty factor rather than the whole session window.
  apprunner: { vcpuHr: 0.064, gbHr: 0.007, vcpu: 1, gb: 2, hoursMo: 730, webDuty: 0.25 },
  // Bedrock AgentCore Runtime (the coding microVM). Idle CPU is FREE — billed only
  // during active compute (duty factor); memory billed across the active session.
  agentcore: { vcpuHr: 0.0895, gbHr: 0.00945, vcpu: 1, gb: 2, cpuDuty: 0.5 },
  // DynamoDB on-demand (session + metadata rows are tiny).
  dynamo: { perMWrite: 0.625, perMRead: 0.125, writesPerSession: 20, readsPerSession: 20 },
  // Per-developer storage footprint.
  s3: { gbMo: 0.023, gbPerDev: 1 }, // transcripts + artifacts
  efs: { gbMo: 0.3, gbPerDev: 2 }, // live workspace
  cognito: { freeMau: 10000, perMau: 0.015 }, // developers = monthly active users
} as const;

const usd = (n: number) =>
  n >= 100 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(n < 10 ? 2 : 1)}`;

function Field({
  label, value, onChange, min, max, step, suffix,
}: {
  label: string; value: number; onChange: (n: number) => void;
  min: number; max: number; step: number; suffix?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="text-[15px] text-[var(--color-text-primary)]">{label}</label>
        <span className="text-[15px] font-semibold text-[var(--ios-blue)] tabular-nums">
          {value.toLocaleString()}{suffix}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--ios-blue)]"
      />
    </div>
  );
}

export default function CostPage() {
  const [devs, setDevs] = useState(100);
  const [sessionsPerDay, setSessionsPerDay] = useState(4);
  const [minutesPerSession, setMinutesPerSession] = useState(20);
  const [workdays, setWorkdays] = useState(22);

  const calc = useMemo(() => {
    const activeHrs = (devs * sessionsPerDay * minutesPerSession * workdays) / 60;
    const sessionsMo = devs * sessionsPerDay * workdays;

    // App Runner: memory provisioned 24/7 + vCPU only while serving requests.
    const a = RATES.apprunner;
    const apprunner =
      a.gb * a.gbHr * a.hoursMo + activeHrs * a.vcpu * a.vcpuHr * a.webDuty;

    // AgentCore: CPU at duty factor (idle free) + memory across the active session.
    const c = RATES.agentcore;
    const agentcore =
      activeHrs * c.vcpu * c.cpuDuty * c.vcpuHr + activeHrs * c.gb * c.gbHr;

    // DynamoDB on-demand — a handful of tiny reads/writes per session.
    const d = RATES.dynamo;
    const dynamo =
      (sessionsMo * d.writesPerSession / 1e6) * d.perMWrite +
      (sessionsMo * d.readsPerSession / 1e6) * d.perMRead;

    const s3 = devs * RATES.s3.gbPerDev * RATES.s3.gbMo;
    const efs = devs * RATES.efs.gbPerDev * RATES.efs.gbMo;
    const cognito = Math.max(0, devs - RATES.cognito.freeMau) * RATES.cognito.perMau;

    const stores = dynamo + s3 + efs + cognito;
    const infra = apprunner + agentcore + stores;

    return { activeHrs, sessionsMo, apprunner, agentcore, dynamo, s3, efs, cognito, stores, infra };
  }, [devs, sessionsPerDay, minutesPerSession, workdays]);

  const row = (label: string, value: number, dim = false) => (
    <div className="flex items-center justify-between py-2.5 px-4">
      <span className={`text-[15px] ${dim ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-primary)]"}`}>
        {label}
      </span>
      <span className={`text-[15px] tabular-nums ${dim ? "text-[var(--color-text-secondary)]" : "font-semibold text-[var(--color-text-primary)]"}`}>
        {usd(value)}<span className="text-[var(--color-text-muted)] text-[12px] font-normal">/mo</span>
      </span>
    </div>
  );

  return (
    <div className="ios-scroll h-full overflow-y-auto" style={{ background: "var(--color-bg-secondary)" }}>
      <div className="max-w-[640px] mx-auto px-4 pb-16 pt-3">
        <Link
          href="/ember"
          className="press inline-flex items-center gap-1 text-[15px] text-[var(--ios-blue)] mb-3"
        >
          <ChevronLeft className="w-5 h-5 -ml-1" /> Ember
        </Link>

        {/* ── Capacity hero — the delivered ceiling ───────────────────────── */}
        <div
          className="ios-sheet rounded-ios-lg p-6 mb-3 text-center"
          style={{ background: "linear-gradient(180deg,#ffb24d 0%,#ff7a1a 45%,#ff4d00 100%)", boxShadow: "0 8px 24px rgba(255,106,0,0.35)" }}
        >
          <div className="text-white/85 text-[13px] font-medium uppercase tracking-wide">Delivers up to</div>
          <div className="text-white text-[56px] font-bold leading-none tabular-nums my-1">
            {RATES.capacity.concurrentSessions.toLocaleString()}+
          </div>
          <div className="text-white text-[17px] font-semibold">concurrent coding sessions</div>
          <div className="text-white/85 text-[13px] mt-1.5 leading-snug">
            Default AgentCore quota — <strong className="text-white">raises on request</strong>. Auto-scaling
            microVMs spin up on demand and cost <strong className="text-white">$0 when idle</strong>.
          </div>
        </div>

        {/* Capacity facts */}
        <div className="grid grid-cols-3 gap-2 mb-5">
          {[
            ["Developers", "Unlimited"],
            ["Sessions", "On demand"],
            ["Storage", "Scales to need"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-ios px-3 py-2.5 text-center" style={{ background: "var(--color-bg-tertiary)" }}>
              <div className="text-[14px] font-semibold text-[var(--color-text-primary)]">{v}</div>
              <div className="text-[11px] text-[var(--color-text-muted)] uppercase tracking-wide mt-0.5">{k}</div>
            </div>
          ))}
        </div>

        {/* ── Inference: your way ─────────────────────────────────────────── */}
        <div className="rounded-ios-lg p-4 mb-6" style={{ background: "var(--color-bg-tertiary)" }}>
          <div className="text-[15px] font-semibold text-[var(--color-text-primary)] mb-1.5">Inference, your way</div>
          <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed">
            <strong className="text-[var(--color-text-primary)]">Amazon Bedrock out of the box</strong> — Claude,
            no setup. Or bring your own: <strong className="text-[var(--color-text-primary)]">Claude Code</strong>{" "}
            (Pro / Max) and <strong className="text-[var(--color-text-primary)]">Codex</strong> (ChatGPT) logins.
            Inference is billed by your provider — <strong className="text-[var(--ios-green)]">never through Ember</strong>.
            The numbers below are the <strong className="text-[var(--color-text-primary)]">platform only</strong>.
          </p>
        </div>

        <h1 className="text-[28px] font-bold tracking-tight text-[var(--color-text-primary)] mb-1">
          What the platform costs
        </h1>
        <p className="text-[15px] text-[var(--color-text-secondary)] mb-5 leading-snug">
          The full AWS bill to run Ember — compute, storage, and auth. No models, no
          tokens. Drag to match your team.
        </p>

        {/* Headline infra total */}
        <div className="rounded-ios-lg p-5 mb-6 text-center" style={{ background: "var(--color-bg-tertiary)", border: "0.5px solid var(--ios-separator)" }}>
          <div className="text-[var(--color-text-muted)] text-[13px] font-medium uppercase tracking-wide">Estimated monthly infrastructure</div>
          <div className="text-[var(--color-text-primary)] text-[44px] font-bold leading-tight tabular-nums">{usd(calc.infra)}</div>
          <div className="text-[var(--color-text-secondary)] text-[13px]">
            {usd(calc.infra / Math.max(devs, 1))}/developer · {calc.sessionsMo.toLocaleString()} sessions/mo
          </div>
        </div>

        {/* Inputs */}
        <div className="rounded-ios-lg p-4 mb-6 space-y-4" style={{ background: "var(--color-bg-tertiary)" }}>
          <Field label="Developers" value={devs} onChange={setDevs} min={1} max={500} step={1} />
          <Field label="Sessions / dev / day" value={sessionsPerDay} onChange={setSessionsPerDay} min={1} max={30} step={1} />
          <Field label="Active minutes / session" value={minutesPerSession} onChange={setMinutesPerSession} min={5} max={120} step={5} suffix=" min" />
          <Field label="Working days / month" value={workdays} onChange={setWorkdays} min={1} max={31} step={1} />
        </div>

        {/* Breakdown */}
        <div className="text-[13px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] px-4 mb-1.5">
          Breakdown
        </div>
        <div className="rounded-ios-lg overflow-hidden mb-2 divide-y" style={{ background: "var(--color-bg-tertiary)", borderColor: "var(--ios-separator)" }}>
          {row("Compute", calc.apprunner + calc.agentcore)}
          {row("· App Runner (always-on web)", calc.apprunner, true)}
          {row("· AgentCore (coding microVMs)", calc.agentcore, true)}
        </div>
        <div className="rounded-ios-lg overflow-hidden mb-4 divide-y" style={{ background: "var(--color-bg-tertiary)", borderColor: "var(--ios-separator)" }}>
          {row("Storage & auth", calc.stores)}
          {row("· DynamoDB (sessions)", calc.dynamo, true)}
          {row("· S3 (transcripts + artifacts)", calc.s3, true)}
          {row("· EFS (live workspaces)", calc.efs, true)}
          {row(`· Cognito (${devs.toLocaleString()} users)`, calc.cognito, true)}
        </div>

        <div className="rounded-ios px-4 py-3 mb-4 text-[13px] leading-snug"
             style={{ background: "var(--ios-fill-tertiary)", color: "var(--color-text-secondary)" }}>
          <strong className="text-[var(--ios-green)]">Platform only.</strong> This is what you pay AWS to run
          Ember for this team. Models and tokens are not included — sessions run on Bedrock or on the
          Claude / Codex plan you already have, billed by that provider.
        </div>

        <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed px-1">
          Estimates, not a quote. Rates (us-east-1): App Runner ${RATES.apprunner.vcpuHr}/vCPU-hr + ${RATES.apprunner.gbHr}/GB-hr ·
          AgentCore ${RATES.agentcore.vcpuHr}/vCPU-hr (idle CPU free) + ${RATES.agentcore.gbHr}/GB-hr ·
          DynamoDB on-demand ${RATES.dynamo.perMWrite}/M writes + ${RATES.dynamo.perMRead}/M reads ·
          S3 ${RATES.s3.gbMo}/GB-mo · EFS ${RATES.efs.gbMo}/GB-mo ·
          Cognito {RATES.cognito.freeMau.toLocaleString()} MAU free, then ${RATES.cognito.perMau}/MAU.
          Storage assumes ~{RATES.efs.gbPerDev} GB EFS + {RATES.s3.gbPerDev} GB S3 per developer.
          The {RATES.capacity.concurrentSessions.toLocaleString()}+ figure is the default AgentCore Runtime
          active-session quota per account in US East / US West (raisable via AWS Service Quotas) — peak
          concurrency, not a monthly run-rate; you pay only for active compute. App Runner can be paused
          outside work hours to cut its floor further.
        </p>
      </div>
    </div>
  );
}
