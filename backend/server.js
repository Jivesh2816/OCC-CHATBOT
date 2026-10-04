// Entry point for local dev and Vercel. The app itself is built in app.js, so
// tests and the eval can load it without binding a port.
const app = require('./app');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
