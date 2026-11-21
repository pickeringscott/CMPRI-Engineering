"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";


import { useState, type ReactNode } from "react";

function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useUiLanguage();
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
      {copied ? t("Copied!") : label || t("Copy")}
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
  const { t } = useUiLanguage();
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <header className="border-b border-slate-800 pb-6">
          <div data-cmpri-page-heading>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-400">{t("Hawkeye Hotels")}</p>
          <h1 className="mt-1.5 text-2xl font-bold">{t("CMPRI Setup Guide")}</h1>
          </div>
          <p className="mt-2 text-sm text-slate-400">{t("Step-by-step instructions for completing the remaining configuration. Each value has a Copy button so you can paste it exactly where it needs to go.")}</p>
          <p className="mt-3 rounded-lg border border-red-400/30 bg-red-950/20 p-3 text-sm text-red-200">{t("This page is for administrators only. Remove or restrict access before go-live.")}</p>
        </header>

        <div className="mt-6 space-y-4">

          <Step number={1} title="Set the real Supabase Service Role Key (fixes sign-in)">
            <p>{t("This is the most likely cause of the sign-in problem. Without the real key, admin operations fail silently.")}</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>{t("Go to ")}<a href="https://supabase.com/dashboard" className="text-amber-300 underline">{t("supabase.com/dashboard")}</a>{t(" and open your project.")}</li>
              <li>{t("Click ")}<strong>{t("Settings")}</strong>{t(" (gear icon) then ")}<strong>{t("API")}</strong>.</li>
              <li>{t("Under ")}<strong>{t("Project API Keys")}</strong>{t(", find the ")}<strong>{t("service_role")}</strong>{t(" key and click ")}<strong>{t("Reveal")}</strong>.</li>
              <li>{t("Click ")}<strong>{t("Copy")}</strong>{t(" to copy the full key.")}</li>
              <li>{t("In Bolt, go to your project environment variables (or open the ")}<strong>{t(".env")}</strong>{t(" file).")}</li>
              <li>{t("Replace the placeholder value for ")}<code className="rounded bg-slate-950 px-1.5 py-0.5 text-amber-200">SUPABASE_SERVICE_ROLE_KEY</code>{t(" with the real key you copied.")}</li>
              <li>{t("Save and redeploy.")}</li>
            </ol>
            <p className="text-xs text-slate-500">{t("The current value in .env is a placeholder: REPLACE_WITH_REAL_SERVICE_ROLE_KEY")}</p>
          </Step>

          <Step number={2} title="Configure Google Sign-In in Supabase">
            <p>{t("CMPRI uses one Google OAuth client through Supabase Auth. CMPRI does not maintain application passwords or send password-reset emails.")}</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>{t("In Bolt, click the ")}<strong>{t("database icon")}</strong>{t(" at top center.")}</li>
              <li>{t("Click ")}<strong>{t("Authentication")}</strong>{t(" in the left sidebar.")}</li>
              <li>{t("Click ")}<strong>{t("URL Configuration")}</strong>.</li>
              <li>{t("Under ")}<strong>{t("Site URL")}</strong>{t(", paste your current published Bolt site URL (see below).")}</li>
              <li>{t("Under ")}<strong>{t("Redirect URLs")}</strong>{t(", add the published URLs and the local development URL below.")}</li>
              <li>{t("Click ")}<strong>{t("Save")}</strong>.</li>
            </ol>
            <p>{t("The app sends Google sign-in back to the same origin where it was opened. This lets a local build return to localhost while the published build returns to its own domain. Keep Google's authorized redirect URI pointed at the Supabase Auth callback; add local development under Supabase's Redirect URLs.")}</p>
            <p className="font-semibold text-slate-200">{t("Site URL (use your current published Bolt address):")}</p>
            <CopyField text="https://YOUR-PROJECT.bolt.host" label="Copy Bolt URL" />
            <p className="text-xs text-slate-500">{t("Replace YOUR-PROJECT with your actual Bolt project subdomain. You can find it in the browser address bar when viewing the published site.")}</p>
            <p className="font-semibold text-slate-200">{t("Redirect URLs to add (one per line; use the localhost entry for the default Next.js dev port):")}</p>
            <CopyField text="https://YOUR-PROJECT.bolt.host/**" label="Copy" />
            <CopyField text="https://cmpri-engineering.com/**" label="Copy" />
            <CopyField text="http://localhost:3000/**" label="Copy local URL" />
            <p className="text-xs text-slate-500">{t("If the local build runs on a different host or port, add that exact local origin with ")}<code>{"/**"}</code>{t(" instead.")}</p>
            <p className="text-xs text-slate-500">{t("Add the cmpri-engineering.com entry now so it is ready when the domain goes live.")}</p>
          </Step>

          <Step number={3} title="Create approved CMPRI user records">
            <p>{t("Google authentication proves identity. CMPRI user records control application access and roles.")}</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>{t("Create each user with the exact Google email address.")}</li>
              <li>{t("Assign the CMPRI role and active property membership.")}</li>
              <li>{t("Use the same Google sign-in flow for the System Administrator and all other users.")}</li>
              <li>{t("Users recover their accounts through Google account recovery.")}</li>
            </ol>
          </Step>

          <Step number={4} title="Configure cmpri-engineering.com as the Production Domain">
            <p>{t("This must be done through Bolt domain settings and your DNS registrar.")}</p>

            <p className="font-semibold text-amber-300">{t("Part A: Add the domain in Bolt")}</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>{t("In your Bolt project, go to ")}<strong>{t("Domains and Hosting")}</strong>{t(" (or the domain/globe icon).")}</li>
              <li>{t("Click ")}<strong>{t("Connect Domain")}</strong>{t(" or ")}<strong>{t("Add Custom Domain")}</strong>.</li>
              <li>{t("Enter this exact domain:")}</li>
            </ol>
            <CopyField text="cmpri-engineering.com" label="Copy domain" />
            <ol start={4} className="list-inside list-decimal space-y-2">
              <li>{t("Bolt will display the DNS records you need to add.")}</li>
            </ol>

            <p className="font-semibold text-amber-300">{t("Part B: Add DNS records at your registrar")}</p>
            <p>{t("Bolt will show you the exact records. They will typically look like this:")}</p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-400">
                    <th className="py-2 pr-4">{t("Type")}</th>
                    <th className="py-2 pr-4">{t("Host / Name")}</th>
                    <th className="py-2 pr-4">{t("Value")}</th>
                  </tr>
                </thead>
                <tbody className="text-slate-300">
                  <tr className="border-b border-slate-800">
                    <td className="py-2 pr-4 font-mono">{t("CNAME")}</td>
                    <td className="py-2 pr-4 font-mono">{t("cmpri-engineering.com")}</td>
                    <td className="py-2 pr-4 font-mono text-amber-200">{t("YOUR-PROJECT.bolt.host")}</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-mono">{t("TXT")}</td>
                    <td className="py-2 pr-4 font-mono">{t("_bolt-verify.cmpri-engineering.com")}</td>
                    <td className="py-2 pr-4 font-mono text-amber-200">{t("(Bolt will show the exact value)")}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">{t("Copy the exact values Bolt shows you after clicking Connect Domain. The table above is a template; Bolt provides the real values.")}</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>{t("Log in to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.).")}</li>
              <li>{t("Open DNS management for hawkeyehotels.com.")}</li>
              <li>{t("Add each record Bolt showed you with the exact Type, Host, and Value.")}</li>
              <li>{t("Save and wait for DNS to propagate (usually 5-30 minutes).")}</li>
            </ol>

            <p className="font-semibold text-amber-300">{t("Part C: HTTPS")}</p>
            <p>{t("Bolt provisions HTTPS automatically via Let's Encrypt once DNS resolves. No manual SSL setup is needed. Bolt will show a padlock icon when HTTPS is active.")}</p>

            <p className="font-semibold text-amber-300">{t("Part D: Update Supabase Auth URLs after domain is live")}</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>{t("Repeat Step 2 above, but set the Site URL to:")}</li>
            </ol>
            <CopyField text="https://cmpri-engineering.com" label="Copy" />
            <ol start={2} className="list-inside list-decimal space-y-2">
              <li>{t("Add this to the Redirect URLs list (it may already be there from Step 2):")}</li>
            </ol>
            <CopyField text="https://cmpri-engineering.com/**" label="Copy" />

            <p className="font-semibold text-amber-300">{t("Part E: Redirect old Bolt URL to production domain")}</p>
            <ol className="list-inside list-decimal space-y-2">
              <li>{t("In Bolt domain settings, enable ")}<strong>{t("Redirect to primary domain")}</strong>.</li>
              <li>{t("This forwards the old YOUR-PROJECT.bolt.host address to cmpri-engineering.com automatically.")}</li>
              <li>{t("Do not remove the old Bolt URL until the redirect is verified working.")}</li>
            </ol>
          </Step>

          <Step number={5} title="End-to-End Verification Checklist">
            <p>{t("After all steps above are complete, verify each item on the published site:")}</p>
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
          <p>{t("CMPRI Engineering v1.0 Setup Guide. This page is for administrative use during initial configuration.")}</p>
        </footer>
      </div>
    </main>
  );
}
