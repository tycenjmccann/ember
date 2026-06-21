"use client";

/**
 * /cost — live cost calculator. The whole pitch in one screen: infrastructure is
 * a rounding error, the LLM is ~all of it, and "bring your own plan" makes the LLM
 * term $0 marginal. Rates are the public AWS/Anthropic numbers as of 2026-06; they
 * live in RATES so they're easy to update when prices move.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

// ─── Rates (USD). Update here when AWS/Anthropic pricing changes. ──────────────
const RATES = {
  // AWS App Runner (web tier), 1 vCPU / 2 GB instance.
  apprunner: { vcpuHr: 0.064, gbHr: 0.007, vcpu: 1, gb: 2, workdayHrs: 10 },
  // Amazon Bedrock AgentCore Runtime (the coding microVM). Idle CPU is free, so we
  // bill CPU at an effective duty factor; memory is billed across the active session.
  agentcore: { vcpuHr: 0.0895, gbHr: 0.00945, vcpu: 1, gb: 2, cpuDuty: 0.5 },
  // DynamoDB on-demand + S3 for a coding workload — flat pennies.
  storesMonthly: 2,
  // LLM, per active session-hour. Token throughput is a heavy-use estimate
  // (prompt caching typically makes the real input bill lower).
  llm: {
    inputMTokPerHr: 1.0,
    outputMTokPerHr: 0.2,
    models: {
      "bedrock-opus": { label: "Bedrock · Claude Opus", inPerM: 15, outPerM: 75 },
      "bedrock-sonnet": { label: "Bedrock · Claude Sonnet", inPerM: 3, outPerM: 15 },
      "byo-plan": { label: "Your own plan (Pro/Max or ChatGPT)", inPerM: 0, outPerM: 0 },
    },
  },
} as const;

type ModelKey = keyof typeof RATES.llm.models;

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
  const [devs, setDevs] = useState(5);
  const [sessionsPerDay, setSessionsPerDay] = useState(4);
  const [minutesPerSession, setMinutesPerSession] = useState(20);
  const [workdays, setWorkdays] = useState(22);
  const [model, setModel] = useState<ModelKey>("byo-plan");

  const calc = useMemo(() => {
    const activeHrs =
      (devs * sessionsPerDay * minutesPerSession * workdays) / 60;

    // App Runner: memory provisioned across the workday + active vCPU bursts.
    const a = RATES.apprunner;
    const apprunnerMem = a.gb * a.gbHr * a.workdayHrs * workdays;
    const apprunnerCpu = activeHrs * a.vcpu * a.vcpuHr; // web tier only computes during requests
    const apprunner = apprunnerMem + apprunnerCpu;

    // AgentCore: CPU at duty factor (idle is free), memory across active session.
    const c = RATES.agentcore;
    const agentcore =
      activeHrs * c.vcpu * c.cpuDuty * c.vcpuHr + activeHrs * c.gb * c.gbHr;

    const stores = RATES.storesMonthly;
    const infra = apprunner + agentcore + stores;

    // LLM
    const m = RATES.llm.models[model];
    const llm =
      activeHrs *
      (RATES.llm.inputMTokPerHr * m.inPerM + RATES.llm.outputMTokPerHr * m.outPerM);

    return { activeHrs, apprunner, agentcore, stores, infra, llm, total: infra + llm };
  }, [devs, sessionsPerDay, minutesPerSession, workdays, model]);

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

        <h1 className="text-[28px] font-bold tracking-tight text-[var(--color-text-primary)] mb-1">
          What it costs
        </h1>
        <p className="text-[15px] text-[var(--color-text-secondary)] mb-6 leading-snug">
          Infrastructure is a rounding error. The model is ~all of it — and{" "}
          <strong className="text-[var(--color-text-primary)]">$0 marginal</strong> when sessions
          run on a plan you already pay for.
        </p>

        {/* Headline total */}
        <div
          className="ios-sheet rounded-ios-lg p-5 mb-6 text-center"
          style={{ background: "linear-gradient(180deg,#ffb24d 0%,#ff7a1a 45%,#ff4d00 100%)", boxShadow: "0 8px 24px rgba(255,106,0,0.35)" }}
        >
          <div className="text-white/80 text-[13px] font-medium uppercase tracking-wide">Estimated monthly</div>
          <div className="text-white text-[44px] font-bold leading-tight tabular-nums">{usd(calc.total)}</div>
          <div className="text-white/85 text-[13px]">
            {usd(calc.total / Math.max(devs, 1))}/developer · {Math.round(calc.activeHrs)} active session-hours
          </div>
        </div>

        {/* Inputs */}
        <div className="rounded-ios-lg p-4 mb-6 space-y-4" style={{ background: "var(--color-bg-tertiary)" }}>
          <Field label="Developers" value={devs} onChange={setDevs} min={1} max={500} step={1} />
          <Field label="Sessions / dev / day" value={sessionsPerDay} onChange={setSessionsPerDay} min={1} max={30} step={1} />
          <Field label="Active minutes / session" value={minutesPerSession} onChange={setMinutesPerSession} min={5} max={120} step={5} suffix=" min" />
          <Field label="Working days / month" value={workdays} onChange={setWorkdays} min={1} max={31} step={1} />

          <div>
            <label className="text-[15px] text-[var(--color-text-primary)] block mb-2">Model</label>
            <div className="grid grid-cols-1 gap-2">
              {(Object.keys(RATES.llm.models) as ModelKey[]).map((k) => {
                const active = k === model;
                return (
                  <button
                    key={k}
                    onClick={() => setModel(k)}
                    className="press text-left rounded-ios px-3.5 py-2.5 text-[15px] transition-colors"
                    style={{
                      background: active ? "var(--ios-blue)" : "var(--ios-fill-tertiary)",
                      color: active ? "#fff" : "var(--color-text-primary)",
                    }}
                  >
                    {RATES.llm.models[k].label}
                    {k === "byo-plan" && (
                      <span className={`ml-2 text-[12px] ${active ? "text-white/80" : "text-[var(--ios-green)]"}`}>
                        $0 marginal
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Breakdown */}
        <div className="text-[13px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] px-4 mb-1.5">
          Breakdown
        </div>
        <div className="rounded-ios-lg overflow-hidden mb-2 divide-y" style={{ background: "var(--color-bg-tertiary)", borderColor: "var(--ios-separator)" }}>
          {row("Infrastructure", calc.infra)}
          {row("· App Runner (web)", calc.apprunner, true)}
          {row("· AgentCore (coding microVMs)", calc.agentcore, true)}
          {row("· DynamoDB + S3", calc.stores, true)}
        </div>
        <div className="rounded-ios-lg overflow-hidden mb-4" style={{ background: "var(--color-bg-tertiary)" }}>
          {row(model === "byo-plan" ? "LLM (your plan)" : "LLM (Bedrock tokens)", calc.llm)}
        </div>

        {model === "byo-plan" && (
          <div className="rounded-ios px-4 py-3 mb-4 text-[13px] leading-snug"
               style={{ background: "var(--ios-fill-tertiary)", color: "var(--color-text-secondary)" }}>
            <strong className="text-[var(--ios-green)]">Bring your own plan:</strong> sessions run on the
            Claude Pro/Max or ChatGPT subscription you already pay for. The only cost above is the AWS
            infrastructure to host it — typically <strong className="text-[var(--color-text-primary)]">{usd(calc.infra)}/mo</strong> for this team.
          </div>
        )}

        <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed px-1">
          Estimates, not a quote. Rates: App Runner ${RATES.apprunner.vcpuHr}/vCPU-hr + ${RATES.apprunner.gbHr}/GB-hr ·
          AgentCore ${RATES.agentcore.vcpuHr}/vCPU-hr (idle CPU free) + ${RATES.agentcore.gbHr}/GB-hr ·
          LLM assumes ~{RATES.llm.inputMTokPerHr}M input + {RATES.llm.outputMTokPerHr}M output tokens per active
          session-hour (prompt caching usually lowers the real input bill). Bedrock Opus ${RATES.llm.models["bedrock-opus"].inPerM}/${RATES.llm.models["bedrock-opus"].outPerM} per
          M tok in/out. App Runner can be paused outside work hours to cut its floor toward $0.
        </p>
      </div>
    </div>
  );
}
