"use client";

import { createAuthClient } from "better-auth/react";
import { API_URL } from "./data";

/**
 * Auth client (§3 Better Auth). Sessions live on the API (:3001) as cookies;
 * localhost ports and prod subdomains are same-site, so the default Lax
 * cookie rides along as long as fetches use credentials: "include".
 * In demo mode (no API_URL) there is nothing to sign in to.
 */
export const authClient = createAuthClient({
  baseURL: API_URL || undefined,
});

export const { useSession, signIn, signUp, signOut } = authClient;
