# Front-end integration guide — Authentication & Authorization (Vue.js)

This document explains how a front-end developer using Vue.js should implement authentication and authorization when talking to the JWT-based backend in this repository.

## Contract (inputs / outputs / errors)

- Inputs: user credentials (email, password) from login form.
- Outputs: JWT (access token) returned by backend; front-end attaches `Authorization: Bearer <token>` on protected requests.
- Error modes: invalid credentials (401), expired token (401), network errors.

## Backend API (available endpoints)

- POST /admin/register — create an admin (body: { name, email, password })
- POST /admin/login — returns { token }
- Public routes (no auth required):
  - GET /client
  - POST /client
  - GET /management
  - POST /management
- Protected routes (require Authorization header):
  - GET /admin/protected
  - POST /admin/protected
  - GET /client/protected
  - POST /client/protected
  - GET /management/protected
  - POST /management/protected

Tokens are JWTs signed by the server; expiry is configured server-side (default 1h). The payload contains at least the admin email and id.

## Storage & security recommendations

- Preferred: keep token in memory (Pinia/Vuex). This is safest vs XSS but lost on full reload.
- Best: use HttpOnly, Secure cookies set by server (prevents JS from reading token). Requires server support.
- Practical/common: `sessionStorage` or `localStorage` (vulnerable to XSS). If you must use this, harden the app with CSP, input sanitization, and escape all outputs.

Recommendation for this project: store token in Pinia and optionally persist to `sessionStorage` for convenience during development.

## Implementation pattern (minimal)

The snippets below show a recommended approach using Axios, Pinia and Vue Router.

1. Axios instance with auth interceptor (attach token and handle 401)

```javascript
// src/lib/api.js
import axios from "axios";
import { useAuthStore } from "@/stores/auth";

const api = axios.create({ baseURL: process.env.VUE_APP_API_URL || "" });

api.interceptors.request.use((config) => {
  const store = useAuthStore();
  if (store.token) config.headers.Authorization = `Bearer ${store.token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response && err.response.status === 401) {
      const store = useAuthStore();
      store.logout();
      // optionally redirect to login
    }
    return Promise.reject(err);
  }
);

export default api;
```

2. Pinia auth store (token + login/logout)

```javascript
// src/stores/auth.js
import { defineStore } from "pinia";
import api from "@/lib/api";

export const useAuthStore = defineStore("auth", {
  state: () => ({ token: sessionStorage.getItem("token") || null, user: null }),
  actions: {
    async login(email, password) {
      const { data } = await api.post("/admin/login", { email, password });
      this.token = data.token;
      sessionStorage.setItem("token", data.token); // optional
    },
    logout() {
      this.token = null;
      this.user = null;
      sessionStorage.removeItem("token");
    },
  },
});
```

3. Router guard

```javascript
// src/router/index.js
import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({ history: createWebHistory(), routes: [...] });

router.beforeEach((to, from, next) => {
  const store = useAuthStore();
  if (to.meta.requiresAuth && !store.token) return next({ path: '/login', query: { redirect: to.fullPath } });
  next();
});

export default router;
```

4. Login flow example (component)

```vue
<template>
  <form @submit.prevent="onSubmit">
    <input v-model="email" />
    <input v-model="password" type="password" />
    <button type="submit">Login</button>
  </form>
</template>
<script setup>
import { ref } from "vue";
import { useAuthStore } from "@/stores/auth";
import { useRouter, useRoute } from "vue-router";

const email = ref("");
const password = ref("");
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

async function onSubmit() {
  try {
    await auth.login(email.value, password.value);
    const redirect = route.query.redirect || "/";
    router.push(redirect);
  } catch (err) {
    /* show error */
  }
}
</script>
```

## Protected vs Unprotected routes (front-end behavior)

- Unprotected GET/POST: call normally (no Authorization header needed).
- Protected GET/POST: ensure token exists and axios interceptor will attach it. Use router guard for navigation blocking. On 401, clear auth and redirect to login.

## Token expiry & refresh

- If token expires, backend returns 401. Simple front-end behavior: redirect to login on 401.
- Better approach: implement refresh tokens (requires backend changes). I can add a refresh-token flow if you want.

## Role-based authorization

- Include `role` in JWT payload on login. Check `role` client-side for UI/route hiding. Always enforce role server-side as well.

## Security checklist

- Use HTTPS in production.
- Use strong `JWT_SECRET` as env var on server.
- Create DB unique index on email (admins collection).
- Consider HttpOnly cookies for refresh tokens.
- Add rate limiting on login endpoint.

## Next suggested tasks

- (Optional) Add `POST /auth/refresh` and refresh-token cookie flow.
- Add Joi/Zod validation on inputs.
- Add DB indexes and migrations on startup.

---

If you want, I can add the Pinia files, axios instance, and router changes directly into the repo as a ready-to-use scaffold. Tell me and I will create the files.
