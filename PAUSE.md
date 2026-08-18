# OpenCorp — mise en pause (2026-08-18)

Le projet est mis en pause : l'abonnement VPS a été fermé. Ce document est
l'état figé du système et la procédure exacte pour l'éteindre proprement puis
le relancer plus tard. Il remplace toute reconstitution de mémoire — tout ce
qu'il faut savoir est ici.

---

## 1. État figé au 2026-08-18

| Élément | Valeur |
|---|---|
| VPS | `89.116.110.150` — `ssh opencorp-vps`, repo `/opt/opencorp`, uptime 59 j |
| Abonnement VPS | **fermé** — la machine sera recyclée par l'hébergeur |
| Stack | 9 conteneurs (`docker compose -f infra/compose/docker-compose.prod.yml`) |
| Commit déployé | `dcd5a3e` (PR #31, heartbeat resilience) |
| Domaine | `opencorp.app` — **conservé** |
| Dashboard | Vercel, projet `opencorp` (`prj_1n1M9jBijKDCmgFXmYtapN5ONtzM`) |
| Sandbox | `SANDBOX_KIND=local` — pas de coût E2B en prod |
| Stripe | **`sk_test`** — mode test, aucun argent réel en jeu |

### Entreprises (5)

| Slug | Statut | Revenu | Dépense | Tâches en file |
|---|---|---|---|---|
| terravalue | **active** | 0 | 4,39 € | 22 |
| saucraft | paused | 0 | 1,40 € | 1 |
| brewtiful-workdays | paused | 0 | 0,10 € | 3 |
| coolparis | paused | 58,00 €* | 3,50 € | 0 |
| zenith-focus | paused | 0 | 0,20 € | 7 |

\* argent **fictif** (Stripe test) — rien à retirer.

`terravalue` était encore active : dernier heartbeat le **2026-08-18 à 07:00 UTC**.
C'est la seule source de dépense LLM quotidienne restante.

### Ledger

- **4353 événements**, du 2026-06-19 11:02 au 2026-08-18 07:00 UTC
- Chaîne de hash **vérifiée intègre** : `{"ok": true, "checked": 4353}`
- Hash de tête : `b11df9176ed206a48ab4e8c8de0cef13840c8b49d27f189d54d133ecc1c41c4b`

---

## 2. Sauvegarde — FAITE ✅

Emplacement : `~/Documents/OpenCorp-archive-2026-08-18/`
(hors du dépôt git — contient des secrets)

| Fichier | Contenu |
|---|---|
| `pg_dumpall.sql.gz` | dump logique complet (toutes DB + rôles) |
| `opencorp.dump` | DB de contrôle + ledger (format custom) |
| `corp_*.dump` | 5 DB par entreprise (quasi vides, ~1 Ko) |
| `sites.tar.gz` | sites web publiés par les agents |
| `stalwart.tar.gz` | boîtes mail (80 Mo) |
| `caddy_data.tar.gz` | certificats TLS |
| `env.prod.backup` | `.env.prod` — **secrets**, chmod 600 |
| `ledger-export.json` | 4353 événements en JSON lisible sans Postgres |
| `ledger-verify.json` | preuve d'intégrité de la chaîne |
| `companies-snapshot.json` | état des 5 entreprises |

Intégrité vérifiée : md5 identiques VPS ↔ local, archives gzip testées.

> ⚠️ Cette archive est la **seule** copie du monde de référence. Pense à en
> mettre un exemplaire ailleurs (disque externe / stockage chiffré).

---

## 3. Extinction

### 3.1 Arrêter la stack — FAIT ✅ (2026-08-18)

```sh
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod down
```

Les 9 conteneurs sont arrêtés et supprimés ; les 5 volumes sont **intacts**
(`down` sans `-v`). `api`/`gw`/`*.opencorp.app` ne répondent plus. La dépense
LLM quotidienne est stoppée.

### 3.2 Nettoyer le DNS — FAIT ✅ (2026-08-18)

Le domaine est enregistré **chez Vercel** (nameservers Vercel, expire le
**11 juin 2027**), donc le DNS se pilote en CLI : `vercel dns ls|rm`.

Six enregistrements pointaient vers `89.116.110.150` et ont été supprimés —
`*` (wildcard), `api`, `gw`, `llm`, `mail` (A) et `mail` (MX). Sans ça, le jour
où l'hébergeur réattribue cette IP, le nouveau locataire aurait pu servir ce
qu'il voulait sur `*.opencorp.app`, avec un certificat valide via Caddy
on-demand TLS (*subdomain takeover*).

Vérifié auprès de 1.1.1.1 et 8.8.8.8 : plus aucun nom ne résout vers l'ancienne
IP. Le wildcard retombe sur l'ALIAS Vercel par défaut.

**Conservés** (aucune référence au VPS, utiles à la reprise) : les
enregistrements Resend `send.mail` (SPF + MX), `resend._domainkey.mail` (DKIM)
et `_dmarc.mail`.

### 3.3 Révoquer les clés API — À FAIRE (manuel)

Le disque du VPS part au recyclage avec `.env.prod` dessus. À révoquer dans
chaque console (accès manuel requis) :

- [ ] **Anthropic** — `ANTHROPIC_API_KEY` → console.anthropic.com/settings/keys
- [ ] **z.ai** — `ZAI_API_KEY` (bundle GLM, utilisé par les 5 entreprises)
- [ ] **Resend** — `RESEND_API_KEY` → resend.com/api-keys
- [ ] **Stripe (test)** — `sk_test_…` + webhook `whsec_…` → dashboard.stripe.com
      (mode test ; supprimer aussi l'endpoint webhook qui pointe vers l'API morte)
- [ ] **GitHub OAuth App** — `GITHUB_CLIENT_SECRET` → github.com/settings/developers
- [ ] **Secrets internes** (deviennent caducs avec le VPS, mais à ne pas réutiliser
      tels quels à la reprise) : `BETTER_AUTH_SECRET`, `GATEWAY_SECRET`,
      `LITELLM_API_KEY`, `POSTGRES_PASSWORD`, `STALWART_*`

À la reprise : régénérer tout ça (`openssl rand -hex 32` pour les secrets internes).

### 3.4 Vitrine « en pause » — DÉPLOYÉE ✅ / bascule du domaine À FAIRE

Le dashboard Next.js dépend de l'API pour chaque page : sans backend, il rend
des erreurs 500. Il a donc été remplacé par un site **statique** autonome.

- Sources : `~/Documents/OpenCorp-archive-2026-08-18/paused-site/`
- Projet Vercel : **`opencorp-paused`** (séparé de `opencorp` exprès — sinon la
  fusion d'une PR sur `master` relancerait le build Next.js et écraserait la
  page de pause)
- En ligne : <https://opencorp-paused.vercel.app>
- Contenu : landing « projet en pause » + ledger figé navigable (4353
  événements, filtres) + export JSON complet téléchargeable

**Reste à faire — bascule du domaine (dashboard Vercel, ~30 s) :**

1. Projet `opencorp` → Settings → Domains → retirer `opencorp.app`
2. Projet `opencorp-paused` → Settings → Domains → ajouter `opencorp.app`

> ⚠️ À faire dans le dashboard, **pas** avec `vercel domains rm` : cette
> commande retire la *propriété du domaine sur le compte*, et le domaine est
> enregistré chez Vercel. La CLI ne sait pas détacher un domaine d'un projet.

Tant que la bascule n'est pas faite, `opencorp.app` sert l'ancien dashboard qui
répond 200 mais affiche des erreurs 500 partout.

---

## 4. Reprise du projet

1. Nouveau VPS (4 vCPU / 8 Go / 40 Go, Ubuntu 22.04+), Docker + compose.
2. `git clone` le dépôt, `cp .env.prod.example .env.prod`, régénérer **tous**
   les secrets (cf. §3.3) — ne pas recopier `env.prod.backup` tel quel.
3. Recréer les DNS du §3.2 vers la nouvelle IP.
4. Restaurer l'état :
   ```sh
   docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod up -d postgres
   gunzip -c pg_dumpall.sql.gz | docker exec -i opencorp-prod-postgres-1 psql -U opencorp
   docker compose -f infra/compose/docker-compose.prod.yml --env-file .env.prod up -d --build
   ```
5. Restaurer les volumes `sites` / `stalwartdata` depuis les `.tar.gz`.
6. Vérifier le ledger : `bun run ledger:verify` — doit rendre la même tête de
   chaîne qu'au §1 si rien n'a été perdu.
7. Les entreprises reprennent leurs heartbeats via leurs Temporal Schedules.
   `POST /admin/schedules/backfill` si les schedules n'ont pas été recréés.
8. Rebasculer `opencorp.app` du projet `opencorp-paused` vers `opencorp`.
9. Le reste de la procédure d'installation est dans [DEPLOY.md](./DEPLOY.md).

---

## 5. Travail en cours au moment de la pause

- **PR #25** — `feat-ads-agent-tools` : régie publicitaire pilotée par les
  agents + client Meta Graph réel. Étape 0 (outils → agents) et étape 1 (client
  Meta) faites ; **prochaine étape : le flux OAuth de connexion du compte
  propriétaire**. Seule branche non fusionnée.
- Toutes les autres branches sont fusionnées dans `master` et peuvent être
  supprimées.
- Audits ouverts, non traités : `AUDIT_AUTONOMOUS_COMPANIES.md` (constats F3,
  F5, F6, F7 encore ouverts).
