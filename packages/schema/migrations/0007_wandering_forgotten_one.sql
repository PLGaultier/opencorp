CREATE TYPE "public"."ad_campaign_status" AS ENUM('paused', 'active', 'archived');--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid,
	"provider" text NOT NULL,
	"provider_ref" text,
	"name" text NOT NULL,
	"objective" text NOT NULL,
	"status" "ad_campaign_status" DEFAULT 'paused' NOT NULL,
	"budget_cents" bigint NOT NULL,
	"budget_type" text DEFAULT 'daily' NOT NULL,
	"creative" jsonb,
	"launched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"day" text NOT NULL,
	"spend_cents" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "ad_monthly_budget_cap_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conglomerates" ADD COLUMN "meta_ad_account_id" text;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_campaign_day_uq" ON "ad_spend" USING btree ("campaign_id","day");