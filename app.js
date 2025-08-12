// app.js
const express  = require('express');
const ejs      = require('ejs');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const _        = require('lodash');
const bcrypt   = require('bcrypt');

const saltRounds = 10;
const months = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

const app = express();
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));

// ---- DB ----
mongoose.connect(
  "mongodb+srv://admin:SkSBcB1qnCkR2cIH@cluster0-bw7ds.mongodb.net/googlesheetsdb",
  { useNewUrlParser: true, useUnifiedTopology: true }
);

// ---- Schemas / Models ----
const adminSchema = new mongoose.Schema({
  fName: String, lName: String, password: String, email: String, permissions: Array
});
const Admin = mongoose.model("Admin", adminSchema);

const slotSchema = new mongoose.Schema({
  physName: String,
  date: Date,
  timeStart: String,     // e.g., "9:00 AM"
  physSpecialty: String,
  timeEnd: String,       // e.g., "11:30 AM"
  location: String,
  notes: String,
  testId: String,
  studentName: String,
  studentEmail: String,
  dDate: String,
  dTime: String,
  filled: Boolean
});
const Slot = mongoose.model("Slot", slotSchema);

const studentSchema = new mongoose.Schema({
  fName: String,
  lName: String,
  password: String,
  email: String,
  appId: String,
  group: String,
  matchingLocked: Boolean,
  // NEW
  isLyte: { type: Boolean, default: false },
  school: { type: String, default: "" }
});
const Student = mongoose.model("Student", studentSchema);

const confirmSchema = new mongoose.Schema({
  email: String,
  confirmed: Boolean
});
const Confirm = mongoose.model("Confirm", confirmSchema);

const controlSchema = new mongoose.Schema({
  maxSlots: Number,
  PCPonly: Boolean,
  matchingLocked: { type: Boolean, default: false },
  id: Number, // future: groups allowed
});
const Control = mongoose.model("Control", controlSchema);

const logSchema = new mongoose.Schema({
  time: String, type: String, user: String, update: String, slot: String
});
const Log = mongoose.model("Log", logSchema);

// ---- Helpers ----
const ALLOWED_PCP = new Set(["Family Medicine (PCP)", "Primary Care"]);
function isPCPSlot(slot) {
  return ALLOWED_PCP.has((slot?.physSpecialty || "").trim());
}

function makeLog(type, user, update, slotId) {
  const date = new Date();
  if (!slotId || slotId === " ") return;
  Slot.findOne({ _id: slotId }, function (err, foundSlot) {
    if (err || !foundSlot) return;
    const newLog = new Log({
      time:
        (1 + date.getMonth()) + "/" + date.getDate() + " " +
        date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds(),
      type, user, update,
      slot: `${foundSlot.physName} ${foundSlot.timeStart} ${foundSlot.date}`
    });
    newLog.save(() => {});
  });
}

function parseTimeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  let s = t.trim().toLowerCase();
  s = s.replace(/\s+/g, ''); // "9:00am" or "13:15"
  // Detect am/pm
  let ampm = null;
  if (s.endsWith('am')) { ampm = 'am'; s = s.slice(0, -2); }
  if (s.endsWith('pm')) { ampm = 'pm'; s = s.slice(0, -2); }

  const parts = s.split(':');
  if (parts.length < 1 || parts.length > 2) return null;
  let h = parseInt(parts[0], 10);
  let m = parts.length === 2 ? parseInt(parts[1], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  if (ampm) {
    // 12-hour to 24-hour
    if (ampm === 'am') {
      if (h === 12) h = 0;
    } else {
      // pm
      if (h !== 12) h += 12;
    }
  }
  // 24-hour assumed if no am/pm
  return h * 60 + m;
}

function slotHours(slot) {
  const start = parseTimeToMinutes(slot?.timeStart);
  const end   = parseTimeToMinutes(slot?.timeEnd);
  if (start == null || end == null) return 0;
  const diffMin = Math.max(0, end - start);
  return Math.round((diffMin / 60) * 100) / 100; // 2 decimals
}

function setDisplayValues(slots) {
  const list = Array.isArray(slots) ? slots : [];
  const normalized = list.map((s) => {
    const obj = (s && typeof s.toObject === 'function') ? s.toObject() : (s || {});
    let dDate = "";
    if (obj.date) {
      const dt = new Date(obj.date);
      if (!isNaN(dt.getTime())) {
        dDate = `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
      }
    }
    return {
      ...obj,
      dDate,
      isPCP: isPCPSlot(obj)
    };
  });

  normalized.sort((a, b) => {
    const aT = a.date ? new Date(a.date).getTime() : 0;
    const bT = b.date ? new Date(b.date).getTime() : 0;
    return aT - bT;
  });

  return normalized;
}

function errorPage(res, err) {
  return res.render("error", { errM: err?.message || String(err) });
}

// Load controls for views
app.use(async (req, res, next) => {
  try {
    res.locals.controls = await Control.findOne({ id: 1 }).lean();
  } catch (e) {
    console.error("Failed to load controls:", e);
    res.locals.controls = null;
  }
  next();
});

let maxSlots = 100;
let allGroups = [];
function updateGroups() {
  Student.find(function (err, students) {
    if (err) return;
    const seen = new Set(allGroups.map(g => g[0]));
    students.forEach(st => {
      if (!seen.has(st.group)) {
        allGroups.push([st.group, false]);
        seen.add(st.group);
      }
    });
  });
}
updateGroups();

// Single place to render "home" with correct confirmed flag
async function renderHome(res, userEmail, errM = "") {
  try {
    const [foundUser, slotsRaw, ctrl, confirmDoc] = await Promise.all([
      userEmail ? Student.findOne({ email: userEmail }).lean() : null,
      Slot.find({}).lean(),
      Control.findOne({ id: 1 }).lean(),
      userEmail ? Confirm.findOne({ email: userEmail }).lean() : null
    ]);

    const slots = setDisplayValues(slotsRaw || []);
    const confirmed = !!(confirmDoc && confirmDoc.confirmed);

    res.render("home", {
      user: foundUser,
      slots,
      controls: ctrl,
      maxSlots: (ctrl && ctrl.maxSlots) || maxSlots,
      errM,
      confirmed
    });
  } catch (e) {
    console.error(e);
    return errorPage(res, e);
  }
}

// Build admin analytics (per-student hours, by-school totals)
function buildAdminAnalytics(allSlots, allStudents, lyteOnly = false) {
  const byEmail = {};
  allStudents.forEach(st => {
    const email = (st.email || "").toLowerCase();
    if (!email) return;
    byEmail[email] = {
      name: (st.fName ? st.fName : "") + (st.lName ? (" " + st.lName) : ""),
      email,
      school: st.school || "",
      isLyte: !!st.isLyte,
      hours: 0
    };
  });

  (allSlots || []).forEach(slot => {
    const email = (slot.studentEmail || "").toLowerCase();
    if (!email || !byEmail[email]) return;
    byEmail[email].hours += slotHours(slot);
  });

  let studentHours = Object.values(byEmail)
    .map(s => ({ ...s, hours: Math.round(s.hours * 100) / 100 }))
    .sort((a, b) => b.hours - a.hours);

  if (lyteOnly) {
    studentHours = studentHours.filter(s => s.isLyte);
  }

  const schoolTotals = {};
  studentHours.forEach(s => {
    const key = s.school || "(No school)";
    schoolTotals[key] = (schoolTotals[key] || 0) + s.hours;
  });

  const hoursBySchool = Object.entries(schoolTotals)
    .map(([school, hours]) => ({ school, hours: Math.round(hours * 100) / 100 }))
    .sort((a, b) => b.hours - a.hours);

  return { studentHours, hoursBySchool };
}

// Single place to render admin dashboard
async function renderAdminHome(res, flashMsg = "", lyteOnly = false) {
  try {
    const [slots, confirms, ctrl, students] = await Promise.all([
      Slot.find({}).lean(),
      Confirm.find({}).lean(),
      Control.findOne({ id: 1 }).lean(),
      Student.find({}).lean()
    ]);
    const array = setDisplayValues(slots);

    const { studentHours, hoursBySchool } = buildAdminAnalytics(slots, students, lyteOnly);

    res.render("admin-home", {
      slots: array,
      maxSlots: (ctrl && ctrl.maxSlots) || maxSlots,
      allGroups: allGroups.sort(),
      confirms,
      errM: flashMsg || "",
      // NEW for the admin view:
      studentHours,
      hoursBySchool,
      lyteOnly // echo current filter so the UI can show it
    });
  } catch (e) {
    return errorPage(res, e);
  }
}

// ---- Routes ----
// GET
app.get("/", function (req, res) {
  res.render("landing");
});
app.get("/admin", function (req, res) {
  const lyteOnly = String(req.query.lyte || "").toLowerCase() === "true";
  return renderAdminHome(res, "", lyteOnly);
});
app.get("/admin-login", function (req, res) {
  res.render("admin-login", { errM: "" });
});
app.get("/login", function (req, res) {
  res.render("login", { errM: "", errM2: "" });
});
app.get("/activate-account", function (req, res) {
  res.render("activate-account", { errM: "", errM2: "" });
});
app.get('*', function (req, res) {
  res.redirect('/');
});

// POST — Activate account
app.post("/activate-account", function (req, res) {
  const email = _.toLower(req.body.email);
  const password = req.body.password;

  Student.findOne({ email }, function (err, foundUser) {
    if (err) return res.render("activate-account", { errM: "An error occured. Please try again or contact apolloyimde@gmail.com." });
    if (!foundUser) return res.render("activate-account", { errM: "Email not found. Please use the login information sent to you or contact apolloyimde@gmail.com." });
    if (foundUser.fName) return res.render("activate-account", { errM: "An account with this email has already been activated. Please use the login page or contact apolloyimde@gmail.com." });

    bcrypt.compare(password, foundUser.password, function (err, ok) {
      if (err || !ok) return res.render("activate-account", { errM: "Incorrect password. Please use the login information sent to you or contact apolloyimde@gmail.com." });

      Student.updateOne(
        { email },
        { fName: _.startCase(req.body.fName), lName: _.startCase(req.body.lName) },
        async function (err) {
          if (err) return res.render("activate-account", { errM: "An error occured. Please try again or contact apolloyimde@gmail.com." });
          return renderHome(res, email, "Account activated!");
        }
      );
    });
  });
});

// POST — Student login
app.post("/login", function (req, res) {
  const email = _.toLower(req.body.email);
  const password = req.body.password;

  Student.findOne({ email }, function (err, foundUser) {
    if (err) return res.render("login", { errM: "", errM2: "An error occured. Please try again." });
    if (!foundUser) return res.render("login", { errM: "", errM2: "Username or password was incorrect." });
    if (!foundUser.fName) {
      return res.render("login", {
        errM: "", errM2: "Account not activated. Please activate your account (https://the-match-apolloyim-2f158c0ae122.herokuapp.com/activate-account) or contact apolloyimde@gmail.com."
      });
    }

    bcrypt.compare(password, foundUser.password, function (err, ok) {
      if (err || !ok) return res.render("login", { errM: "", errM2: "Username or password was incorrect." });
      return renderHome(res, foundUser.email, "");
    });
  });
});

// POST — Admin login -> go to admin dashboard
app.post("/admin-login", function (req, res) {
  const email = _.toLower(req.body.email);
  const password = req.body.password;

  Admin.findOne({ email }, function (err, foundAdmin) {
    if (err) return res.render("admin-login", { errM: "An error occurred. Please try again." });
    if (!foundAdmin) return res.render("admin-login", { errM: "Email not found." });

    bcrypt.compare(password, foundAdmin.password, async function (err, ok) {
      if (err) return res.render("admin-login", { errM: "An error occurred. Please try again." });
      if (!ok) return res.render("admin-login", { errM: "Incorrect password." });
      return renderAdminHome(res, "Logged in.");
    });
  });
});

// POST — Claim (blocked if matchingLocked)
app.post("/claim", function (req, res) {
  const userEmail = _.toLower(req.body.userEmail);
  const slotId = req.body.slotId;

  Control.findOne({ id: 1 }).lean().exec(function (err, ctrl) {
    if (err) return errorPage(res, err);

    if (ctrl && ctrl.matchingLocked === true) {
      return renderHome(res, userEmail, "Matching is currently locked. You can review/remove your matches but cannot add new ones.");
    }

    Slot.findOne({ _id: slotId }, function (err, slot) {
      if (err || !slot) return errorPage(res, err || "Slot not found.");

      if (slot.studentEmail) {
        return renderHome(res, userEmail, "This slot was already claimed. Please reload to see the latest availability.");
      }

      Slot.updateOne(
        { _id: slotId },
        { studentName: `${req.body.userFName} ${req.body.userLName}`, studentEmail: userEmail },
        function (err) {
          if (err) return errorPage(res, err);
          makeLog("Claim slot", userEmail, slotId, slotId);
          return renderHome(res, userEmail, "Successfully matched.");
        }
      );
    });
  });
});

// POST — Unclaim (allowed even when locked, UNLESS confirmed)
app.post("/unclaim", async function (req, res) {
  const slotId = req.body.slotId;
  const userEmail = _.toLower(req.body.userEmail);

  try {
    const confirmDoc = await Confirm.findOne({ email: userEmail }).lean();
    if (confirmDoc && confirmDoc.confirmed) {
      return renderHome(res, userEmail, "You have already confirmed your slots. You can no longer remove them.");
    }

    await Slot.updateOne({ _id: slotId }, { studentName: "", studentEmail: "" });

    makeLog("Unclaim", userEmail, slotId, slotId);
    return renderHome(res, userEmail, "Successfully removed slot.");
  } catch (err) {
    return errorPage(res, err);
  }
});

// POST — Confirm (sets confirmed flag; disables confirm button on home)
app.post("/confirm", function (req, res) {
  const userEmail = _.toLower(req.body.userEmail);
  Confirm.updateOne(
    { email: userEmail },
    { $set: { confirmed: true } },
    { upsert: true },
    function (err) {
      if (err) return errorPage(res, err);
      return renderHome(res, userEmail, "Successfully confirmed your slots.");
    }
  );
});

// POST — Admin: bulk create accounts (admins + students)
// New format per line: email///password///group///isLyte///school
// - isLyte: yes/no/true/false (optional; default false)
// - school: free text (optional; default "")
app.post("/admin-newAccounts", function (req, res) {
  const uploadUserArray = req.body.uploadUsers || "";
  const users = uploadUserArray
    .split("###")
    .map(x => x.split("///").map(p => (p || "").trim()))
    .filter(parts => parts.filter(Boolean).length >= 2); // at least email & password

  users.forEach((parts) => {
    const email = parts[0];
    const password = parts[1];
    const group = parts[2] || "";
    const isLyteRaw = (parts[3] || "").toLowerCase();
    const school = parts[4] || "";

    const isLyte = (isLyteRaw === "yes" || isLyteRaw === "true" || isLyteRaw === "y" || isLyteRaw === "1");

    if (email && password) {
      bcrypt.hash(password, saltRounds, function (err, hashedPassword) {
        if (err) return;
        const newStudent = new Student({
          email: _.toLower(email),
          password: hashedPassword,
          group,
          isLyte,
          school
        });
        newStudent.save(() => {});
      });
    }
  });

  const uploadAdmins = req.body.uploadAdmins || "";
  let admins = uploadAdmins.split("###").map(x => x.split("///"));
  admins.forEach(function (admin) {
    const fName = admin[0], lName = admin[1], email = admin[2], password = admin[3];
    if (fName && lName && email && password) {
      bcrypt.hash(password, saltRounds, function (err, hashedPassword) {
        if (err) return;
        const newAdmin = new Admin({
          fName, lName, email: _.toLower(email), password: hashedPassword
        });
        newAdmin.save(() => { });
      });
    }
  });

  return renderAdminHome(res, "Accounts processed.");
});

// POST — Admin: match settings (lock toggle, maxSlots)
app.post("/admin-matchSettings", function (req, res) {
  const maxSlotsValue = parseInt(req.body.maxSlots || maxSlots, 10);
  const lockValue = req.body.matchingLock === "true";

  // remember checked groups (optional)
  for (let i = 0; i < allGroups.length; i++) {
    const box = req.body[allGroups[i][0]];
    allGroups[i][1] = !!box;
  }

  Control.updateOne(
    { id: 1 },
    { $set: { matchingLocked: lockValue, maxSlots: maxSlotsValue } },
    { upsert: true },
    function (err) {
      if (err) {
        console.error("Error updating Control:", err);
        return renderAdminHome(res, "Error updating match settings.");
      }
      Student.updateMany({}, { matchingLocked: lockValue }, function () {
        return renderAdminHome(res, "Match settings updated.");
      });
    }
  );
});

// POST — Admin: reset ALL confirmations (clean slate)
app.post("/admin-reset-confirms", async function (req, res) {
  try {
    await Confirm.updateMany({}, { $unset: { confirmed: "" } });
    return renderAdminHome(res, "All confirmations cleared.");
  } catch (err) {
    return errorPage(res, err);
  }
});

// POST — Admin: clear confirmation for ONE student
app.post("/admin-clear-confirm", async function (req, res) {
  try {
    const email = _.toLower(req.body.email || "");
    if (!email) return renderAdminHome(res, "No email provided.");
    await Confirm.updateOne({ email }, { $unset: { confirmed: "" } }, { upsert: false });
    return renderAdminHome(res, `Confirmation cleared for ${email}.`);
  } catch (err) {
    return errorPage(res, err);
  }
});

// ---- Server ----
let port = process.env.PORT;
if (!port) port = 3000;

app.listen(port, function () {
  console.log("Server started!");
});
