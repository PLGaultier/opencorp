import { BadgeIcon, type BadgeIconName } from "../../sprites";

/**
 * Achievements — display-only, derived from data the page already has (no
 * backend). Locked badges render greyed out so there's always a next goal.
 */

interface BadgeDef {
  icon: BadgeIconName;
  name: string;
  desc: string;
  earned: boolean;
}

export function CompanyBadges({
  revenueCents,
  pnlCents,
  productCount,
  hasDeploy,
  emailsSent,
}: {
  revenueCents: number;
  pnlCents: number;
  productCount: number;
  hasDeploy: boolean;
  emailsSent: number;
}) {
  const badges: BadgeDef[] = [
    { icon: "flag", name: "Founded", desc: "Company created", earned: true },
    { icon: "rocket", name: "Site live", desc: "First deploy shipped", earned: hasDeploy },
    { icon: "cart", name: "Merchant", desc: "First product listed", earned: productCount > 0 },
    { icon: "star", name: "First sale", desc: "Real revenue earned", earned: revenueCents > 0 },
    { icon: "mail", name: "Outreach", desc: "First email sent", earned: emailsSent > 0 },
    { icon: "bolt", name: "In the black", desc: "P&L turned positive", earned: pnlCents > 0 },
  ];

  return (
    <div className="badge-grid">
      {badges.map((b) => (
        <div key={b.name} className={`badge-card ${b.earned ? "" : "locked"}`} title={b.desc}>
          <BadgeIcon icon={b.icon} size={18} />
          <div>
            <b>{b.name}</b>
            <span>{b.earned ? b.desc : "Locked"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
