// app.js
const express    = require('express');
const ejs        = require('ejs');
const bodyParser = require('body-parser');
const mongoose   = require('mongoose');
const _          = require('lodash');
const bcrypt     = require('bcrypt');

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
  fName:String, lName:String, password:String, email:String, permissions:Array
});
const Admin = mongoose.model("Admin", adminSchema);

const slotSchema = new mongoose.Schema({
  physName: String,
  date: Date,
  timeStart: String,     // "9:00 AM"
  physSpecialty:String,
  timeEnd: String,       // "11:30 AM"
  location:String,
  notes:String,
  testId:String,
  studentName:String,
  studentEmail:String,
  dDate:String,
  dTime:String,
  filled: Boolean
});
const Slot = mongoose.model("Slot", slotSchema);

const studentSchema = new mongoose.Schema({
  fName:String, lName:String, password:String, email:String, appId:String,
  group:String, matchingLocked: Boolean,
  isLyte: { type: Boolean, default: false },
  school: { type: String, default: "" },

  // NEW
  isArchived: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null }
});

const Student = mongoose.model("Student", studentSchema);

const confirmSchema = new mongoose.Schema({
  email: String,
  confirmed: Boolean
});
const Confirm = mongoose.model("Confirm", confirmSchema);

// Control doc now includes "phase"
//  phase 0: View-only
//  phase 1: PCP-only
//  phase 2: Max 2
//  phase 3: Unlimited (or use maxSlots if you set it)
// "PCPonly" kept for backward compatibility but derived from phase.
const controlSchema = new mongoose.Schema({
  id: Number,
  phase: { type: Number, default: 3 },          // NEW
  maxSlots: { type: Number, default: 100 },     // used when phase === 3 or you want a custom cap
  PCPonly: { type: Boolean, default: false },   // legacy flag; will mirror (phase === 1)
  matchingLocked: { type: Boolean, default: false }
});
const Control = mongoose.model("Control", controlSchema);

const logSchema = new mongoose.Schema({
  time:String, type:String, user:String, update:String, slot: String
});
const Log = mongoose.model("Log", logSchema);

// ---- Helpers ----
const ALLOWED_PCP = new Set(["Family Medicine (PCP)", "Primary Care"]);
function isPCPSlot(slot) {
  return ALLOWED_PCP.has((slot?.physSpecialty || "").trim());
}

function phaseName(n) {
  switch (Number(n)) {
    case 0: return "Phase 0 — View Only";
    case 1: return "Phase 1 — PCP Only";
    case 2: return "Phase 2 — Select up to 2";
    case 3: return "Phase 3 — Unlimited";
    default: return "Phase ?";
  }
}

function makeLog(type, user, update, slotId){
  const date = new Date();
  if (!slotId || slotId === " ") return;
  Slot.findOne({_id:slotId}, function(err, foundSlot){
    if (err || !foundSlot) return;
    const newLog = new Log ({
      time: (1+date.getMonth())+"/"+date.getDate()+" "+date.getHours()+":"+date.getMinutes()+":"+date.getSeconds(),
      type, user, update, // activated email or slotid
      slot: `${foundSlot.physName} ${foundSlot.timeStart} ${foundSlot.date}`
    });
    newLog.save(()=>{});
  });
}

// Parse times like "1:00 PM", "09:30 am" to minutes since midnight
function parseTimeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  let s = t.trim().toLowerCase().replace(/\s+/g, '');
  let ampm = null;
  if (s.endsWith('am')) { ampm = 'am'; s = s.slice(0, -2); }
  else if (s.endsWith('pm')) { ampm = 'pm'; s = s.slice(0, -2); }

  const parts = s.split(':');
  if (parts.length < 1 || parts.length > 2) return null;
  let h = parseInt(parts[0], 10);
  let m = parts.length === 2 ? parseInt(parts[1], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  if (ampm) {
    if (ampm === 'am') { if (h === 12) h = 0; }
    else { if (h !== 12) h += 12; }
  }
  return h * 60 + m;
}

function slotHours(slot) {
  const start = parseTimeToMinutes(slot?.timeStart);
  const end   = parseTimeToMinutes(slot?.timeEnd);
  if (start == null || end == null) return 0;
  const diffMin = Math.max(0, end - start);
  return Math.round((diffMin / 60) * 100) / 100; // 2 decimals
}

function setDisplayValues(slots){
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

// Load controls into res.locals for easy access in views
app.use(async (req, res, next) => {
  try {
    let ctrl = await Control.findOne({ id: 1 }).lean();
    if (!ctrl) {
      // seed a default control doc
      await Control.updateOne(
        { id: 1 },
        { $setOnInsert: { id:1, phase:3, maxSlots:100, PCPonly:false, matchingLocked:false } },
        { upsert: true }
      );
      ctrl = await Control.findOne({ id: 1 }).lean();
    }
    // ensure legacy PCPonly mirrors phase 1
    if (ctrl.PCPonly !== (ctrl.phase === 1)) {
      await Control.updateOne({ id:1 }, { $set: { PCPonly: (ctrl.phase === 1) } });
      ctrl.PCPonly = (ctrl.phase === 1);
    }
    res.locals.controls = ctrl;
  } catch (e) {
    console.error("Failed to load controls:", e);
    res.locals.controls = null;
  }
  next();
});

let defaultMaxSlots = 100;
let allGroups = [];
function updateGroups(){
  Student.find(function(err, students){
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

// Pick effective cap based on phase/controls
function effectiveMaxSlots(ctrl) {
  if (!ctrl) return 0;
  if (ctrl.phase === 2) return 2;         // Phase 2: hard cap at 2
  if (ctrl.phase === 3) return 0;         // Phase 3: unlimited (no UI cap)
  // phases 0 & 1: no numeric cap (UI/phase rules handle availability)
  return 0;
}

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

    // current student claimed count
    let currentCount = 0;
    if (userEmail) {
      currentCount = await Slot.countDocuments({ studentEmail: userEmail });
    }

    res.render("home", {
      user: foundUser,
      slots,
      controls: ctrl,
      phase: ctrl?.phase ?? 3,
      phaseName: phaseName(ctrl?.phase),
      maxSlots: effectiveMaxSlots(ctrl),
      currentCount,
      errM,
      confirmed,
      isConfirmed: confirmed
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

    // NEW: split
    const activeStudents   = students.filter(s => !s.isArchived);
    const archivedStudents = students.filter(s =>  s.isArchived);

    const { studentHours: activeHours,   hoursBySchool } = buildAdminAnalytics(slots, activeStudents, lyteOnly);
    const { studentHours: archivedHours }                = buildAdminAnalytics(slots, archivedStudents, lyteOnly);

    res.render("admin-home", {
      slots: setDisplayValues(slots),
      controls: ctrl,
      maxSlots: effectiveMaxSlots(ctrl),
      allGroups: allGroups.sort(),
      confirms,
      errM: flashMsg || "",
      studentHours: activeHours,     // default section = Active
      archivedStudentHours: archivedHours, // NEW
      hoursBySchool,
      lyteOnly
    });
  } catch (e) {
    return errorPage(res, e);
  }
}


// ---- CSV helpers ----
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Export: Students CSV (includes total hours + slot count, filterable by LYTE & school)
app.get("/admin/export/students.csv", async function(req, res) {
  try {
    const filter = {};
    if (req.query.lyte === "1") filter.isLyte = true;
    if (req.query.school && req.query.school.trim()) filter.school = req.query.school.trim();

    // NEW: exclude archived unless explicitly requested
    if (req.query.includeArchived !== "1") {
      filter.isArchived = { $ne: true };
    }
  
    const [students, slots] = await Promise.all([
      Student.find(filter).lean(),
      Slot.find({}).lean()
    ]);

    const byEmail = new Map();
    slots.forEach(s => {
      const email = (s.studentEmail || "").toLowerCase();
      if (!email) return;
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(s);
    });

    let rows = [];
    rows.push([
      "Email","First Name","Last Name","Group","Is LYTE","School",
      "Total Slots","Total Hours"
    ].map(csvEscape).join(","));

    students.forEach(st => {
      const email = (st.email || "").toLowerCase();
      const mySlots = byEmail.get(email) || [];
      const totalSlots = mySlots.length;
      const totalHours = mySlots.reduce((sum, s) => sum + slotHours(s), 0);
      rows.push([
        email,
        st.fName || "",
        st.lName || "",
        st.group || "",
        st.isLyte ? "yes" : "no",
        st.school || "",
        String(totalSlots),
        totalHours.toFixed(2)
      ].map(csvEscape).join(","));
    });

    const csv = rows.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=students.csv");
    res.send(csv);
  } catch (e) {
    return errorPage(res, e);
  }
});

// Export: Slots CSV (every slot with who picked it)
app.get("/admin/export/slots.csv", async function(req, res) {
  try {
    const slots = await Slot.find({}).lean();
    let rows = [];
    rows.push([
      "Physician","Specialty","Date","Start","End","Location","Notes",
      "Student Name","Student Email","Hours"
    ].map(csvEscape).join(","));

    slots.forEach(s => {
      const hours = slotHours(s);
      const dDate = s.dDate || (s.date ? new Date(s.date).toISOString().slice(0,10) : "");
      rows.push([
        s.physName || "",
        s.physSpecialty || "",
        dDate,
        s.timeStart || "",
        s.timeEnd || "",
        s.location || "",
        s.notes || "",
        s.studentName || "",
        s.studentEmail || "",
        hours ? hours.toFixed(2) : "0"
      ].map(csvEscape).join(","));
    });

    const csv = rows.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=slots.csv");
    res.send(csv);
  } catch (e) {
    return errorPage(res, e);
  }
});

// ---- Routes ----
// GETs
app.get("/", function(req,res){
  res.render("landing");
});
app.get("/admin", function(req,res){
  const lyteOnly = String(req.query.lyte || "").toLowerCase() === "true";
  return renderAdminHome(res, "", lyteOnly);
});
app.get("/admin-login", function(req,res){
  res.render("admin-login", {errM:""});
});
app.get("/login", function(req,res){
  res.render("login", {errM:"", errM2:""});
});
app.get("/activate-account", function(req,res){
  res.render("activate-account", {errM:"", errM2:""});
});




// --- Admin Search ---
app.get("/admin/search", async function(req, res) {
  try {
    const q = (req.query.q || "").trim();
    const query = q.toLowerCase();

    // counts for the header
    const [totalStudents, totalSlots] = await Promise.all([
      Student.countDocuments({}),
      Slot.countDocuments({})
    ]);

    if (!query) {
      return res.render("admin-search", {
        query: "",
        totalStudents,
        totalSlots,
        studentResults: [],
        physicianGroups: []
      });
    }

    // --- Student search ---
    // Match on name or email
    const nameRx = new RegExp(_.escapeRegExp(query), "i");
    const students = await Student.find({
      $or: [
        { email: nameRx },
        { fName: nameRx },
        { lName: nameRx }
      ]
    }).lean();

    // For each student, gather claimed slots + hours + status
    const byEmail = new Map();
    const slots = await Slot.find({}).lean();
    slots.forEach(s => {
      const em = (s.studentEmail || "").toLowerCase();
      if (!em) return;
      if (!byEmail.has(em)) byEmail.set(em, []);
      byEmail.get(em).push(s);
    });

    // confirmations map
    const confirms = await Confirm.find({}).lean();
    const confirmedMap = new Map(confirms.map(c => [c.email.toLowerCase(), !!c.confirmed]));

    const studentResults = students.map(st => {
      const email = (st.email || "").toLowerCase();
      const my = byEmail.get(email) || [];
      const totalHours = my.reduce((sum, s) => {
        const start = (s.timeStart || "").trim();
        const end   = (s.timeEnd || "").trim();
        // reuse your slotHours logic if available; otherwise quick calc fallback:
        const parse = t => {
          if (!t) return 0;
          const m = /(\d+):(\d+)\s*(AM|PM)/i.exec(t);
          if (!m) return 0;
          let hh = parseInt(m[1],10) % 12;
          const mm = parseInt(m[2],10);
          if (m[3].toUpperCase() === "PM") hh += 12;
          return hh + mm/60;
        };
        const hrs = Math.max(0, parse(end) - parse(start));
        return sum + hrs;
      }, 0);

      return {
        name: [st.fName, st.lName].filter(Boolean).join(" ") || st.email,
        email: st.email,
        group: st.group,
        school: st.school,
        isLyte: !!st.isLyte,
        confirmed: !!confirmedMap.get(email),
        matchingLocked: !!st.matchingLocked,
        isArchived: !!st.isArchived,            // will render Archive/Unarchive buttons
        totalSlots: my.length,
        totalHours,
        slots: my
      };
    });

    // --- Physician/slot search ---
    const physMatches = slots.filter(s => {
      const hay = [
        s.physName, s.physSpecialty, s.location,
        s.notes, s.dDate, s.timeStart, s.timeEnd
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(query);
    });

    // group by physician for display
    const byPhys = new Map();
    physMatches.forEach(s => {
      const key = (s.physName || "—") + "||" + (s.physSpecialty || "");
      if (!byPhys.has(key)) byPhys.set(key, []);
      byPhys.get(key).push(s);
    });

    const physicianGroups = Array.from(byPhys.entries()).map(([key, arr]) => {
      const [physName, physSpecialty] = key.split("||");
      return { physName, physSpecialty, slots: arr };
    });

    return res.render("admin-search", {
      query: q,
      totalStudents,
      totalSlots,
      studentResults,
      physicianGroups
    });
  } catch (e) {
    return errorPage(res, e);
  }
});

app.get('*', function(req, res) {
  res.redirect('/');
});

// POSTs
// Admin login (simple: redirect to /admin on success; no session)
app.post("/admin-login", function(req, res) {
  const email = _.toLower(req.body.email);
  const password = req.body.password;

  Admin.findOne({ email }, function(err, foundAdmin) {
    if (err || !foundAdmin) return res.render("admin-login", { errM: "Email not found." });
    bcrypt.compare(password, foundAdmin.password, function(err, ok) {
      if (err || !ok) return res.render("admin-login", { errM: "Incorrect password." });
      return res.redirect("/admin");
    });
  });
});

// Activate account
app.post("/activate-account", function(req,res){
  const email = _.toLower(req.body.email);
  const password = req.body.password;

  Student.findOne({email}, function(err, foundUser){
    if(err) return res.render("activate-account", {errM:"An error occured. Please try again or contact apolloyimde@gmail.com."});
    if (!foundUser) return res.render("activate-account", {errM:"Email not found. Please use the login information sent to you or contact apolloyimde@gmail.com."});
    if (foundUser.fName) return res.render("activate-account", {errM:"An account with this email has already been activated. Please use the login page or contact apolloyimde@gmail.com."});

    bcrypt.compare(password,foundUser.password, function(err, ok){
      if(err || !ok) return res.render("activate-account", {errM:"Incorrect password. Please use the login information sent to you or contact apolloyimde@gmail.com."});

      Student.updateOne(
        {email},
        {fName:_.startCase(req.body.fName), lName:_.startCase(req.body.lName)},
        async function(err){
          if(err) return res.render("activate-account", {errM:"An error occured. Please try again or contact apolloyimde@gmail.com."});
          return renderHome(res, email, "Account activated!");
        }
      );
    });
  });
});

// Student login
app.post("/login", function(req,res){
  const email = _.toLower(req.body.email);
  const password = req.body.password;

  Student.findOne({email}, function(err, foundUser){
    if(err) return res.render("login", {errM:"", errM2:"An error occured. Please try again."});
    if(!foundUser) return res.render("login", {errM:"", errM2:"Username or password was incorrect."});
    if(!foundUser.fName) {
      return res.render("login", {errM:"", errM2:"Account not activated. Please activate your account (https://the-match-apolloyim-2f158c0ae122.herokuapp.com/activate-account) or contact apolloyimde@gmail.com."});
    }

    // NEW — archived users cannot sign in
    if (foundUser.isArchived) {
      return res.render("login", {errM:"", errM2:"This account has been archived. Please contact apolloyimde@gmail.com if you need access."});
    }

    bcrypt.compare(password, foundUser.password, async function(err, ok){
      if(err || !ok) return res.render("login", {errM:"", errM2:"Username or password was incorrect."});
      return renderHome(res, foundUser.email, "");
    });
  });
});

// Admin: bulk create accounts (admins + students)
app.post("/admin-newAccounts", function(req,res){
  const uploadUserArray = req.body.uploadUsers || "";
  const users = uploadUserArray
    .split("###")
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => x.split("///").map(p => (p || "").trim()));

  function toBool(x){
    const v = String(x || "").trim().toLowerCase();
    return v === "y" || v === "yes" || v === "true" || v === "1";
  }

  users.forEach(function(parts){
    const email = parts[0];
    const password = parts[1];
    const group = parts[2] || "";
    const isLyte = toBool(parts[3]);
    const school = parts[4] || "";

    if(email && password){
      bcrypt.hash(password,saltRounds,function(err,hashedPassword){
        if(err) return;
        const newStudent = new Student ({
          email:_.toLower(email),
          password:hashedPassword,
          group,
          isLyte,
          school
        });
        newStudent.save(()=>{});
      });
    }
  });

  // Admins: First///Last///email///password (### between accounts)
  const uploadAdmins = req.body.uploadAdmins || "";
  const admins = uploadAdmins
    .split("###")
    .map(x => x.trim()).filter(Boolean)
    .map(x => x.split("///"));

  admins.forEach(function(a){
    const fName = a[0], lName = a[1], email = a[2], password = a[3];
    if(fName && lName && email && password){
      bcrypt.hash(password, saltRounds, function(err, hashedPassword){
        if(err) return;
        new Admin({ fName, lName, email: _.toLower(email), password: hashedPassword }).save(()=>{});
      });
    }
  });

  return renderAdminHome(res, "Accounts processed.");
});

// Claim slot — ENFORCE PHASE RULES + MAX SLOTS
app.post("/claim", async function(req,res){
  const userEmail = _.toLower(req.body.userEmail);
  const slotId    = req.body.slotId;

  try {
    const ctrl = await Control.findOne({ id: 1 }).lean();
    if (!ctrl) return renderHome(res, userEmail, "System controls not initialized.");

    // Hard lock (final lock separate from phase)
    if (ctrl.matchingLocked === true) {
      return renderHome(res, userEmail, "Matching is currently locked. You can review/remove your matches but cannot add new ones.");
    }

    // Phase-based gating
    const phase = Number(ctrl.phase || 3);
    const slot = await Slot.findOne({_id:slotId}).lean();
    if (!slot) return errorPage(res, "Slot not found.");

    if (phase === 0) {
      return renderHome(res, userEmail, "View-only phase. You cannot claim slots right now.");
    }
    if (phase === 1 && !isPCPSlot(slot)) {
      return renderHome(res, userEmail, "PCP-only phase. You may only claim Primary Care slots right now.");
    }

    // Enforce caps: phase 2 (2 max) or use ctrl.maxSlots in phase 3
    const myCount = await Slot.countDocuments({ studentEmail: userEmail });
    const cap = (phase === 2) ? 2 : 0; // Phase 2 capped at 2; Phase 3 unlimited
    if (cap > 0 && myCount >= cap) {
      return renderHome(res, userEmail, `You have reached the maximum of ${cap} slot(s) for this phase.`);
    }

    // Double-claim protection
    if (slot.studentEmail) {
      return renderHome(res, userEmail, "This slot was already claimed. Please reload to see the latest availability.");
    }

    await Slot.updateOne(
      { _id: slotId, studentEmail: { $in: [null, "", undefined] } },
      { studentName: `${req.body.userFName} ${req.body.userLName}`, studentEmail: userEmail }
    );

    makeLog("Claim slot", userEmail, slotId, slotId);
    return renderHome(res, userEmail, "Successfully matched.");
  } catch (err) {
    return errorPage(res, err);
  }
});

// Unclaim slot (ALLOWED even when locked, UNLESS already confirmed)
app.post("/unclaim", async function(req, res) {
  const slotId = req.body.slotId;
  const userEmail = _.toLower(req.body.userEmail);

  try {
    const confirmDoc = await Confirm.findOne({ email: userEmail }).lean();
    if (confirmDoc && confirmDoc.confirmed) {
      return renderHome(res, userEmail, "You have already confirmed your slots. You can no longer remove them.");
    }

    await Slot.updateOne(
      { _id: slotId, studentEmail: userEmail },
      { studentName: "", studentEmail: "" }
    );

    makeLog("Unclaim", userEmail, slotId, slotId);
    return renderHome(res, userEmail, "Successfully removed slot.");
  } catch (err) {
    return errorPage(res, err);
  }
});

// Confirm (sets confirmed flag, greys out button on home)
app.post("/confirm", function(req, res) {
  const userEmail = _.toLower(req.body.userEmail);

  Confirm.updateOne(
    { email: userEmail },
    { $set: { confirmed: true } },
    { upsert: true },
    function(err) {
      if (err) return errorPage(res, err);
      return renderHome(res, userEmail, "Successfully confirmed your slots.");
    }
  );
});

// Admin: match settings (lock toggle, phase, maxSlots)
app.post("/admin-matchSettings", async function(req, res) {
  try {
    const phaseValue = Number(req.body.phase ?? 3);
    const maxSlotsValue = parseInt(req.body.maxSlots || 100, 10);
    const lockValue = req.body.matchingLock === "true";

    // remember checked groups (optional)
    for (let i = 0; i < allGroups.length; i++) {
      const box = req.body[allGroups[i][0]];
      allGroups[i][1] = !!box;
    }

    await Control.updateOne(
      { id: 1 },
      {
        $set: {
          phase: phaseValue,
          PCPonly: (phaseValue === 1),
          matchingLocked: lockValue,
          maxSlots: maxSlotsValue
        }
      },
      { upsert: true }
    );

    // propagate "matchingLocked" per-student display flag (legacy behavior)
    await Student.updateMany({}, { matchingLocked: lockValue });

    return renderAdminHome(res, "Match settings updated.");
  } catch (err) {
    console.error("Error updating Control:", err);
    return renderAdminHome(res, "Error updating match settings.");
  }
});

// Admin: reset ALL confirmations (clean slate)
app.post("/admin-reset-confirms", async function(req, res) {
  try {
    await Confirm.updateMany({}, { $unset: { confirmed: "" } });
    return renderAdminHome(res, "All confirmations cleared.");
  } catch (err) {
    return errorPage(res, err);
  }
});

// Admin: clear confirmation for ONE student
app.post("/admin-clear-confirm", async function(req, res) {
  try {
    const email = _.toLower(req.body.email || "");
    if (!email) return renderAdminHome(res, "No email provided.");
    await Confirm.updateOne({ email }, { $unset: { confirmed: "" } }, { upsert: false });
    return renderAdminHome(res, `Confirmation cleared for ${email}.`);
  } catch (err) {
    return errorPage(res, err);
  }
});

// Archive a student (disable account + move to Archived list)
app.post("/admin/students/:email/archive", async function(req, res){
  try {
    const email = _.toLower(req.params.email);
    await Student.updateOne(
      { email },
      { $set: { isArchived: true, archivedAt: new Date() } }
    );

    // send admin back to where they came from
    res.redirect(req.get("Referer") || "/admin");
  } catch (e) { return errorPage(res, e); }
});

app.post("/admin/students/:email/unarchive", async function(req, res){
  try {
    const email = _.toLower(req.params.email);
    await Student.updateOne(
      { email },
      { $set: { isArchived: false, archivedAt: null } }
    );

    res.redirect(req.get("Referer") || "/admin");
  } catch (e) { return errorPage(res, e); }
});


// ---- Server ----
let port = process.env.PORT;
if(!port) port = 3000;

//remove dupes. note this does not clean up mongodb. for next time... :)
async function dedupeCollection(Model, collectionName) {
  const docs = await Model.find({}).lean();
  const seen = new Set();
  const removeIds = [];

  docs.forEach(d => {
    const email = (d.email || "").toLowerCase().trim();
    if (!email) return;
    if (seen.has(email)) {
      removeIds.push(d._id);   // mark as duplicate
    } else {
      seen.add(email);
    }
  });

  if (removeIds.length) {
    console.log(`Removing ${removeIds.length} duplicates from ${collectionName}`);
    await Model.deleteMany({ _id: { $in: removeIds } });
  } else {
    console.log(`No duplicates found in ${collectionName}`);
  }
}
//run cleanup at startup
(async () => {
  try {
    await dedupeCollection(Student, "students");
    await dedupeCollection(Confirm, "confirms");
  } catch (err) {
    console.error("Dedupe error:", err);
  }
})();


app.listen(port, function() {
  console.log("Server started!");
});
