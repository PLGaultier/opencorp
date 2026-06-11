CREATE TYPE "public"."plan_id" AS ENUM('free', 'builder', 'pro');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'canceled');--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conglomerate_id" uuid NOT NULL,
	"plan" "plan_id" NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"provider_ref" text,
	"current_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_conglomerate_id_unique" UNIQUE("conglomerate_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_conglomerate_id_conglomerates_id_fk" FOREIGN KEY ("conglomerate_id") REFERENCES "public"."conglomerates"("id") ON DELETE no action ON UPDATE no action;