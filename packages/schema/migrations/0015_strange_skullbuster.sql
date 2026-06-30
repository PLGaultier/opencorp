CREATE TYPE "public"."model_bundle" AS ENUM('anthropic', 'glm');--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "model_bundle" "model_bundle" DEFAULT 'anthropic' NOT NULL;