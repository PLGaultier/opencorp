CREATE TYPE "public"."lesson_scope" AS ENUM('company', 'conglomerate');--> statement-breakpoint
CREATE TYPE "public"."lesson_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "lesson_scope" NOT NULL,
	"conglomerate_id" uuid NOT NULL,
	"company_id" uuid,
	"category" text DEFAULT 'general' NOT NULL,
	"text" text NOT NULL,
	"evidence" jsonb,
	"score" numeric DEFAULT '1' NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1024),
	"status" "lesson_status" DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'distiller' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reinforced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_conglomerate_id_conglomerates_id_fk" FOREIGN KEY ("conglomerate_id") REFERENCES "public"."conglomerates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lessons_scope_score_idx" ON "lessons" USING btree ("conglomerate_id","company_id","status","score");