# Back-end (Express)

This is a small Express.js backend scaffold with a sample in-memory REST API.

Endpoints:

- GET /health - basic health check
- GET /api/items - list items
- GET /api/items/:id - get item
- POST /api/items - create (JSON { name })
- PUT /api/items/:id - update (JSON { name })
- DELETE /api/items/:id - delete

Setup:

1. Install dependencies:

   npm install

2. Run in development (auto-restart):

   npm run dev

3. Run in production:

   npm start

Notes:

- This uses an in-memory array for demo only. Replace with a real DB for production.
