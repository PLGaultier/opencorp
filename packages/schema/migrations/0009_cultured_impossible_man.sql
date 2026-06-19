CREATE TYPE "public"."model_level" AS ENUM('intern', 'grad', 'phd');--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "model_level" "model_level" DEFAULT 'grad' NOT NULL;