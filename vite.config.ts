import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expose on LAN so phones/laptops in the room can join by IP
    port: 5174,
    // Allow Cloudflare quick-tunnels (any *.trycloudflare.com subdomain) for
    // phone testing when Wi-Fi has client isolation. Leading dot = wildcard.
    allowedHosts: [".trycloudflare.com"],
  },
});
