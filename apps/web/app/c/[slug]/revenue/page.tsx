import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getPayments, getProducts } from "@/lib/data";
import { CopyLink } from "./copy-link";

const eur = (cents: number, currency = "eur") =>
  `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
const dt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

export default async function RevenuePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [data, products, { summary, payments }] = await Promise.all([
    getCompany(slug),
    getProducts(slug),
    getPayments(slug),
  ]);
  if (!data) notFound();
  const { company } = data;

  return (
    <main>
      <Link href={`/c/${slug}`} className="backlink">
        ← {company.name}
      </Link>
      <h1>Revenue</h1>
      <p className="sub">Products the CEO created and every payment received — all on the ledger.</p>

      {/* Revenue summary */}
      <div className="pnl">
        <div>
          <span>Gross revenue</span>
          <b className="pos">{eur(summary.grossCents)}</b>
        </div>
        <div>
          <span>Fees</span>
          <b>{eur(summary.feesCents)}</b>
        </div>
        <div>
          <span>Net revenue</span>
          <b className="pos">{eur(summary.netCents)}</b>
        </div>
        <div>
          <span>Payments</span>
          <b>{summary.count}</b>
        </div>
      </div>

      {/* Product catalogue */}
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Products</h2>
        {products.length === 0 && <p className="sub">No products yet.</p>}
        <div className="product-grid">
          {products.map((p) => (
            <div key={p.id} className="product-card">
              <span className="product-name">{p.name}</span>
              <span className="product-price">{eur(p.priceCents, p.currency)}</span>
              <CopyLink href={p.paymentLink} />
            </div>
          ))}
        </div>
      </section>

      {/* Payment history */}
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Payment history</h2>
        {payments.length === 0 && <p className="sub">No payments yet.</p>}
        {payments.length > 0 && (
          <table className="board">
            <thead>
              <tr>
                <th>Date</th>
                <th>Product</th>
                <th className="num">Gross</th>
                <th className="num">Fees</th>
                <th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((pay) => (
                <tr key={pay.id}>
                  <td style={{ color: "var(--muted)", fontSize: "0.82rem" }}>{dt(pay.createdAt)}</td>
                  <td>{pay.productName ?? "—"}</td>
                  <td className="num pos">{eur(pay.amountCents, pay.currency)}</td>
                  <td className="num" style={{ color: "var(--muted)" }}>
                    {eur(pay.feeCents, pay.currency)}
                  </td>
                  <td className="num pos">{eur(pay.netCents, pay.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
