"use client";

import { useState, type ReactNode } from "react";

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-3 py-1.5 text-xs font-bold text-amber-100 hover:bg-amber-900/40"
    >
      {copied ? "Copied!" : label || "Copy"}
    </button>
  );
}

function CopyField({ text, label }: { text: string; label?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2">
      <code className="flex-1 break-all text-sm text-slate-200">{text}</code>
      <CopyButton text={text} label={label} />
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-400 text-sm font-black text-slate-950">{number}</span>
        <h2 className="text-lg font-bold text-white">{title}</h2>
      </div>
      <div className="mt-4 space-y-3 text-sm text-slate-300">{children}</div>
    </div>
  );
}

export default function SetupGuidePage() {
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <header className="border-b border-slate-800 pb-6">
          <div data-cmpri-page-heading>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">Hawkeye Hotels</p>
          <h1 className="mt-1.5 text-2xl font-bold">CMPRI Setup Guide</h1>
          </div>
          <p className="mt-2 text-sm text-slate-400">
            Step-by-step instructions for completing the remaining configuration.
            Each value has a Copy button so you can paste it exactly where it needs to go.
          </p>
          <p className="mt-3 rounded-lg border border-red-400/30 bg-red-950/20 p-3 text-sm text-red-200">
            This page is for administrators only. Remove or restrict access before go-live.
          </p>
        </header>

        <div className="mt-6 space-y-4">

          <Step number={1} title="Set the real Supabase Service Role Key (fixes sign-in)">
            <p>This is the most likely cause of the sign-in problem. Without the real key, admin operations fail silently.</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>Go to <a href="https://supabase.com/dashboard" className="text-amber-300 underline">supabase.com/dashboard</a> and open your project.</li>
              <li>Click <strong>Settings</strong> (gear icon) then <strong>API</strong>.</li>
              <li>Under <strong>Project API Keys</strong>, find the <strong>service_role</strong> key and click <strong>Reveal</strong>.</li>
              <li>Click <strong>Copy</strong> to copy the full key.</li>
              <li>In Bolt, go to your project environment variables (or open the <strong>.env</strong> file).</li>
              <li>Replace the placeholder value for <code className="rounded bg-slate-950 px-1.5 py-0.5 text-amber-200">SUPABASE_SERVICE_ROLE_KEY</code> with the real key you copied.</li>
              <li>Save and redeploy.</li>
            </ol>
            <p className="text-xs text-slate-500">The current value in .env is a placeholder: REPLACE_WITH_REAL_SERVICE_ROLE_KEY</p>
          </Step>

          <Step number={2} title="Configure Google Sign-In in Supabase">
            <p>CMPRI uses one Google OAuth client through Supabase Auth. CMPRI does not maintain application passwords or send password-reset emails.</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>In Bolt, click the <strong>database icon</strong> at top center.</li>
              <li>Click <strong>Authentication</strong> in the left sidebar.</li>
              <li>Click <strong>URL Configuration</strong>.</li>
              <li>Under <strong>Site URL</strong>, paste your current published Bolt site URL (see below).</li>
              <li>Under <strong>Redirect URLs</strong>, add the published URLs and the local development URL below.</li>
              <li>Click <strong>Save</strong>.</li>
            </ol>
            <p>The app sends Google sign-in back to the same origin where it was opened. This lets a local build return to localhost while the published build returns to its own domain. Keep Google&apos;s authorized redirect URI pointed at the Supabase Auth callback; add local development under Supabase&apos;s Redirect URLs.</p>
            <p className="font-semibold text-slate-200">Site URL (use your current published Bolt address):</p>
            <CopyField text="https://YOUR-PROJECT.bolt.host" label="Copy Bolt URL" />
            <p className="text-xs text-slate-500">Replace YOUR-PROJECT with your actual Bolt project subdomain. You can find it in the browser address bar when viewing the published site.</p>
            <p className="font-semibold text-slate-200">Redirect URLs to add (one per line; use the localhost entry for the default Next.js dev port):</p>
            <CopyField text="https://YOUR-PROJECT.bolt.host/**" label="Copy" />
            <CopyField text="https://cmpri-engineering.com/**" label="Copy" />
            <CopyField text="http://localhost:3000/**" label="Copy local URL" />
            <p className="text-xs text-slate-500">If the local build runs on a different host or port, add that exact local origin with <code>{"/**"}</code> instead.</p>
            <p className="text-xs text-slate-500">Add the cmpri-engineering.com entry now so it is ready when the domain goes live.</p>
          </Step>

          <Step number={3} title="Create approved CMPRI user records">
            <p>Google authentication proves identity. CMPRI user records control application access and roles.</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>Create each user with the exact Google email address.</li>
              <li>Assign the CMPRI role and active property membership.</li>
              <li>Use the same Google sign-in flow for the System Administrator and all other users.</li>
              <li>Users recover their accounts through Google account recovery.</li>
            </ol>
          </Step>

          <Step number={4} title="Configure cmpri-engineering.com as the Production Domain">
            <p>This must be done through Bolt domain settings and your DNS registrar.</p>

            <p className="font-semibold text-amber-300">Part A: Add the domain in Bolt</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>In your Bolt project, go to <strong>Domains and Hosting</strong> (or the domain/globe icon).</li>
              <li>Click <strong>Connect Domain</strong> or <strong>Add Custom Domain</strong>.</li>
              <li>Enter this exact domain:</li>
            </ol>
            <CopyField text="cmpri-engineering.com" label="Copy domain" />
            <ol start={4} className="list-inside list-decimal space-y-2">
              <li>Bolt will display the DNS records you need to add.</li>
            </ol>

            <p className="font-semibold text-amber-300">Part B: Add DNS records at your registrar</p>
            <p>Bolt will show you the exact records. They will typically look like this:</p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-400">
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Host / Name</th>
                    <th className="py-2 pr-4">Value</th>
                  </tr>
                </thead>
                <tbody className="text-slate-300">
                  <tr className="border-b border-slate-800">
                    <td className="py-2 pr-4 font-mono">CNAME</td>
                    <td className="py-2 pr-4 font-mono">cmpri-engineering.com</td>
                    <td className="py-2 pr-4 font-mono text-amber-200">YOUR-PROJECT.bolt.host</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-mono">TXT</td>
                    <td className="py-2 pr-4 font-mono">_bolt-verify.cmpri-engineering.com</td>
                    <td className="py-2 pr-4 font-mono text-amber-200">(Bolt will show the exact value)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">Copy the exact values Bolt shows you after clicking Connect Domain. The table above is a template; Bolt provides the real values.</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>Log in to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.).</li>
              <li>Open DNS management for hawkeyehotels.com.</li>
              <li>Add each record Bolt showed you with the exact Type, Host, and Value.</li>
              <li>Save and wait for DNS to propagate (usually 5-30 minutes).</li>
            </ol>

            <p className="font-semibold text-amber-300">Part C: HTTPS</p>
            <p>Bolt provisions HTTPS automatically via Let&apos;s Encrypt once DNS resolves. No manual SSL setup is needed. Bolt will show a padlock icon when HTTPS is active.</p>

            <p className="font-semibold text-amber-300">Part D: Update Supabase Auth URLs after domain is live</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>Repeat Step 2 above, but set the Site URL to:</li>
            </ol>
            <CopyField text="https://cmpri-engineering.com" label="Copy" />
            <ol start={2} className="list-inside list-decimal space-y-2">
              <li>Add this to the Redirect URLs list (it may already be there from Step 2):</li>
            </ol>
            <CopyField text="https://cmpri-engineering.com/**" label="Copy" />

            <p className="font-semibold text-amber-300">Part E: Redirect old Bolt URL to production domain</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>In Bolt domain settings, enable <strong>Redirect to primary domain</strong>.</li>
              <li>This forwards the old YOUR-PROJECT.bolt.host address to cmpri-engineering.com automatically.</li>
              <li>Do not remove the old Bolt URL until the redirect is verified working.</li>
            </ol>
          </Step>

          <Step number={5} title="End-to-End Verification Checklist">
            <p>After all steps above are complete, verify each item on the published site:</p>
            <ul className="space-y-2">
              {[
                "Google sign-in works",
                "Sign out works",
                "Unapproved Google email is denied",
                "Approved Google email receives its CMPRI role",
                "System Administrator uses the same Google sign-in flow",
                "Auth redirects stay on the correct domain",
                "System Administrators can read and update the private Room Ranker Google Sheet",
                "Staff can stage PM work for review, and System Administrators can approve or reject it before personal-workbook changes apply",
                "No auth flow points back to development URLs",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border border-slate-600 text-xs text-slate-400">{"\u2713"}</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Step>

        </div>

        <footer className="mt-8 border-t border-slate-800 pt-6 text-xs text-slate-500">
          <p>CMPRI Engineering v1.0 Setup Guide. This page is for administrative use during initial configuration.</p>
        </footer>
      </div>
    </main>
  );
}
