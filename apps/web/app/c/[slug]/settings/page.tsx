import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany } from "@/lib/data";
import { isOwner } from "@/lib/server-auth";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!(await isOwner(slug))) notFound(); // owner-only knobs (§4)
  const data = await getCompany(slug);
  if (!data) notFound();
  const { company } = data;

  return (
    <main>
      <Link href={`/c/${slug}`} className="backlink">
        ← {company.name}
      </Link>
      <h1>Settings</h1>
      <p className="sub">
        Owner-only knobs the CEO can never touch: caps, autonomy and public visibility.
      </p>
      <SettingsForm
        companyId={company.id}
        initial={{
          name: company.name,
          mission: company.mission,
          dailyTaskCap: company.dailyTaskCap,
          autonomyLevel: company.autonomyLevel,
          isPublic: company.isPublic,
          adMonthlyBudgetCapCents: company.adMonthlyBudgetCapCents,
        }}
      />
    </main>
  );
}
