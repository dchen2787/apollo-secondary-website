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


// ---- Archived slots (same DB/cluster; separate collection) ----
const archivedSlotSchema = new mongoose.Schema({
  studentEmail: { type: String, index: true },
  studentName: String,

  physName: String,
  physSpecialty: String,
  date: Date,
  timeStart: String,
  timeEnd: String,
  location: String,
  notes: String,

  capturedAt: { type: Date, default: Date.now }, // when we snapshotted
  season: String,                                  // e.g., "2025-09" or "2025 Spring"
  sourceSlotId: { type: String, index: true }      // _id of the live slot at confirm time
}, { strict: true });

// prevent duplicates if confirm is triggered more than once
archivedSlotSchema.index({ studentEmail: 1, sourceSlotId: 1 }, { unique: true });

// IMPORTANT: 3rd arg forces the collection name to be exactly "archivedSlots"
const ArchivedSlot = mongoose.model("ArchivedSlot", archivedSlotSchema, "archivedSlots");

// Hour logger (simple adjustments: +/− hours with reason)
const hourLogSchema = new mongoose.Schema({
  studentEmail: { type: String, index: true },
  deltaHours: Number,     // positive or negative
  reason: String,
  createdAt: { type: Date, default: Date.now }
});
const StudentHourLog = mongoose.model("StudentHourLog", hourLogSchema);

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

    // NEW: independent confirmation window toggle
  confirmationsEnabled: { type: Boolean, default: false }
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

function parseGroupYears(groupStr) {
  if (!groupStr) return { startYear: null, endYear: null };
  const m = String(groupStr).match(/(\d{4})\s*[-–]\s*(\d{4})/); // supports 2025-2027 or 2025 – 2027
  if (!m) return { startYear: null, endYear: null };
  const startYear = parseInt(m[1], 10);
  const endYear   = parseInt(m[2], 10);
  if (Number.isNaN(startYear) || Number.isNaN(endYear)) return { startYear: null, endYear: null };
  return { startYear, endYear };
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

async function snapshotConfirmedSlotsToArchive(studentEmail, seasonLabel = "") {
  const email = (studentEmail || "").toLowerCase().trim();
  if (!email) return { upserted: 0 };

  // All currently claimed slots for this student
  const claimed = await Slot.find({ studentEmail: email }).lean();
  if (!claimed.length) return { upserted: 0 };

  // Idempotent upsert per (studentEmail, sourceSlotId)
  const ops = claimed.map(sl => ({
    updateOne: {
      filter: { studentEmail: email, sourceSlotId: String(sl._id) },
      update: {
        $setOnInsert: {
          studentEmail: email,
          studentName: sl.studentName || "",
          physName: sl.physName || "",
          physSpecialty: sl.physSpecialty || "",
          date: sl.date || null,
          timeStart: sl.timeStart || "",
          timeEnd: sl.timeEnd || "",
          location: sl.location || "",
          notes: sl.notes || "",
          season: seasonLabel || ""
        },
        $set: { capturedAt: new Date() }
      },
      upsert: true
    }
  }));

  const res = await ArchivedSlot.bulkWrite(ops, { ordered: false });
  return { upserted: res.upsertedCount || 0 };
}
// c
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

function archivedSlotHours(h) { return slotHours(h); }


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
    
    // ensure confirmationsEnabled exists if missing
    if (typeof ctrl.confirmationsEnabled === "undefined") {
      await Control.updateOne({ id:1 }, { $set: { confirmationsEnabled:false } });
      ctrl.confirmationsEnabled = false;
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

async function renderAdminHome(res, flashMsg = "", lyteOnly = false) {
  try {
    const [slots, confirms, ctrl, students] = await Promise.all([
      Slot.find({}).lean(),
      Confirm.find({}).lean(),
      Control.findOne({ id: 1 }).lean(),
      Student.find({}).lean()
    ]);

    const activeStudents   = students.filter(s => !s.isArchived);
    const archivedStudents = students.filter(s =>  s.isArchived);

    // map for quick lookup
    const activeEmails = new Set(activeStudents.map(s => (s.email || "").toLowerCase()));
    const confirmsActive = confirms.filter(c => activeEmails.has((c.email || "").toLowerCase()));

    const { studentHours: activeHours,   hoursBySchool } = buildAdminAnalytics(slots, activeStudents, lyteOnly);
    const { studentHours: archivedHours }                = buildAdminAnalytics(slots, archivedStudents, lyteOnly);

    res.render("admin-home", {
      slots: setDisplayValues(slots),
      controls: ctrl,
      maxSlots: effectiveMaxSlots(ctrl),
      allGroups: allGroups.sort(),
      confirms: confirmsActive,          // ← only active students
      errM: flashMsg || "",
      studentHours: activeHours,         // hours list = active only
      archivedStudentHours: archivedHours,
      hoursBySchool,
      lyteOnly
    });
  } catch (e) {
    return errorPage(res, e);
  }
}

// Purge archived slot history for students archived >= 1 year ago
async function purgeOldArchivedHistory() {
  try {
    const cutoff = new Date(Date.now() - 365*24*60*60*1000); // ~1 year
    const oldStudents = await Student.find({
      isArchived: true,
      archivedAt: { $lte: cutoff }
    }).select("email").lean();

    const emails = oldStudents.map(s => (s.email || "").toLowerCase());
    if (!emails.length) {
      console.log("[purge] No archived students older than 1 year.");
      return { deleted: 0, students: 0 };
    }

    const del = await ArchivedSlot.deleteMany({ studentEmail: { $in: emails } });
    console.log(`[purge] Deleted ${del.deletedCount || 0} archived slot doc(s) for ${emails.length} student(s).`);
    return { deleted: del.deletedCount || 0, students: emails.length };
  } catch (e) {
    console.error("[purge] Error:", e);
    return { deleted: 0, students: 0, error: e?.message || String(e) };
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




// --- Admin Search (ranked + full-name aware + grad-year) ---
app.get("/admin/search", async function(req, res) {
  try {
    const qRaw = (req.query.q || "").trim();
    const query = qRaw.toLowerCase();

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

    const tokens = query.split(/\s+/).filter(Boolean);
    const nameRx = new RegExp(_.escapeRegExp(query), "i");

    const orClauses = [
      { email: nameRx },
      { fName: nameRx },
      { lName: nameRx }
    ];
    tokens.forEach(t => {
      const rx = new RegExp(_.escapeRegExp(t), "i");
      orClauses.push({ email: rx }, { fName: rx }, { lName: rx });
    });
    if (tokens.length >= 2) {
      const fRx = new RegExp(_.escapeRegExp(tokens[0]), "i");
      const lRx = new RegExp(_.escapeRegExp(tokens[1]), "i");
      const fRx2 = new RegExp(_.escapeRegExp(tokens[1]), "i");
      const lRx2 = new RegExp(_.escapeRegExp(tokens[0]), "i");
      orClauses.push({ $and: [ { fName: fRx }, { lName: lRx } ] });
      orClauses.push({ $and: [ { fName: fRx2 }, { lName: lRx2 } ] });
    }

    // Pull candidates by name/email first
    let students = await Student.find({ $or: orClauses }).lean();

    // If query looks like a grad year, include those students too
    const yearMatch = query.match(/^\d{4}$/);
    if (yearMatch) {
      const gradYear = parseInt(yearMatch[0], 10);
      const byId = new Map(students.map(s => [String(s._id), s]));
      const all = await Student.find({}).lean();
      all.forEach(s => {
        const { endYear } = parseGroupYears(s.group);
        if (endYear === gradYear && !byId.has(String(s._id))) {
          byId.set(String(s._id), s);
        }
      });
      students = Array.from(byId.values());
    }

    const slots = await Slot.find({}).lean();

    const byEmail = new Map();
    slots.forEach(s => {
      const em = (s.studentEmail || "").toLowerCase();
      if (!em) return;
      if (!byEmail.has(em)) byEmail.set(em, []);
      byEmail.get(em).push(s);
    });

    const confirms = await Confirm.find({}).lean();
    const confirmedMap = new Map(confirms.map(c => [c.email.toLowerCase(), !!c.confirmed]));

    function scoreStudent(st) {
      const email = (st.email || "").toLowerCase();
      const f = (st.fName || "").toLowerCase();
      const l = (st.lName || "").toLowerCase();
      const full = (f && l) ? (f + " " + l) : (f || l);
      let score = 0;
      if (email === query) score += 1200;
      if (full === query)  score += 1100;
      if (tokens[0] && f.startsWith(tokens[0])) score += 160;
      if (tokens[1] && l.startsWith(tokens[1])) score += 160;
      if (full.startsWith(query)) score += 180;
      tokens.forEach(t => {
        if (f.includes(t)) score += 40;
        if (l.includes(t)) score += 40;
        if (email.includes(t)) score += 60;
        if (full.includes(t))  score += 45;
      });
      if (full.includes(query))  score += 70;
      if (email.includes(query)) score += 90;
      if (!st.isArchived) score += 10;
      // slight boost if grad-year matches for year queries
      const ym = query.match(/^\d{4}$/);
      if (ym) {
        const gy = parseInt(ym[0], 10);
        const { endYear } = parseGroupYears(st.group);
        if (endYear === gy) score += 150;
      }
      return score;
    }

    const studentResultsScored = students.map(st => {
      const email = (st.email || "").toLowerCase();
      const mine = byEmail.get(email) || [];
      const totalHours = mine.reduce((sum, s) => sum + slotHours(s), 0);
      return {
        _score: scoreStudent(st),
        name: [st.fName, st.lName].filter(Boolean).join(" ") || st.email,
        email: st.email,
        group: st.group,
        school: st.school,
        isLyte: !!st.isLyte,
        confirmed: !!confirmedMap.get(email),
        matchingLocked: !!st.matchingLocked,
        isArchived: !!st.isArchived,
        totalSlots: mine.length,
        totalHours,
        slots: mine
      };
    });

    const studentResults = studentResultsScored
      .sort((a, b) =>
        (b._score - a._score) ||
        (b.totalHours - a.totalHours) ||
        (b.totalSlots - a.totalSlots) ||
        a.name.localeCompare(b.name)
      )
      .map(({ _score, ...rest }) => rest);

    // Physician/slot search unchanged
    const physMatches = slots.filter(s => {
      const hay = [
        s.physName, s.physSpecialty, s.location, s.notes, s.dDate, s.timeStart, s.timeEnd
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(query);
    });

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
      query: qRaw,
      totalStudents,
      totalSlots,
      studentResults,
      physicianGroups
    });
  } catch (e) {
    return errorPage(res, e);
  }
});

// --- Admin: Student Detail ---
app.get("/admin/students/:email", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    const [st, slots, confirms, archived, hourLogs] = await Promise.all([
      Student.findOne({ email }).lean(),
      Slot.find({ $or: [{ studentEmail: email }, { studentEmail: null }, { studentEmail: "" }] }).lean(),
      Confirm.findOne({ email }).lean(),
      ArchivedSlot.find({ studentEmail: email }).sort({ capturedAt: -1 }).lean(),
      StudentHourLog.find({ studentEmail: email }).sort({ createdAt: -1 }).lean()
    ]);
    if (!st) return errorPage(res, "Student not found");

    const claimed = slots.filter(s => (s.studentEmail||"").toLowerCase() === email);
    const open    = slots.filter(s => !s.studentEmail);

    const archivedWithHours = (archived || []).map(h => ({ ...h, _hours: archivedSlotHours(h) || 0 }));
    const currentClaimedHours = (claimed || []).reduce((sum, s) => sum + slotHours(s), 0);
    const archivedHours = archivedWithHours.reduce((sum, h) => sum + h._hours, 0);
    const adjustments = (hourLogs || []).reduce((sum, a) => sum + (Number(a.deltaHours)||0), 0);
    const lifetimeHours = Math.round((archivedHours + adjustments) * 100) / 100;

    res.render("admin-student", {
      s: st,
      claimed,
      open,
      confirmed: !!(confirms && confirms.confirmed),
      archived: archivedWithHours,
      hourLogs,
      totals: {
        currentClaimedHours: Math.round(currentClaimedHours * 100) / 100,
        archivedHours: Math.round(archivedHours * 100) / 100,
        adjustments: Math.round(adjustments * 100) / 100,
        lifetimeHours
      }
    });
  } catch (e) { return errorPage(res, e); }
});

// --- Admin search suggestions (names/emails + grad-year) ---
app.get("/admin/search/suggest", async function(req, res) {
  try {
    const qRaw = (req.query.q || "").trim();
    const q = qRaw.toLowerCase();
    if (!q) return res.json({ ok: true, suggestions: [] });

    const tokens = q.split(/\s+/).filter(Boolean);
    const nameRx = new RegExp(_.escapeRegExp(q), "i");
    const orClauses = [
      { email: nameRx }, { fName: nameRx }, { lName: nameRx }
    ];
    tokens.forEach(t => {
      const rx = new RegExp(_.escapeRegExp(t), "i");
      orClauses.push({ email: rx }, { fName: rx }, { lName: rx });
    });
    if (tokens.length >= 2) {
      const fRx = new RegExp(_.escapeRegExp(tokens[0]), "i");
      const lRx = new RegExp(_.escapeRegExp(tokens[1]), "i");
      const fRx2 = new RegExp(_.escapeRegExp(tokens[1]), "i");
      const lRx2 = new RegExp(_.escapeRegExp(tokens[0]), "i");
      orClauses.push({ $and: [ { fName: fRx }, { lName: lRx } ] });
      orClauses.push({ $and: [ { fName: fRx2 }, { lName: lRx2 } ] });
    }

    let students = await Student.find({ $or: orClauses })
      .select("fName lName email group isArchived")
      .limit(100)
      .lean();

    // Add grad year matches if q is YYYY
    const ym = q.match(/^\d{4}$/);
    if (ym) {
      const gy = parseInt(ym[0], 10);
      const byId = new Map(students.map(s => [String(s._id), s]));
      const all = await Student.find({})
        .select("fName lName email group isArchived")
        .lean();
      all.forEach(s => {
        const { endYear } = parseGroupYears(s.group);
        if (endYear === gy && !byId.has(String(s._id))) byId.set(String(s._id), s);
      });
      students = Array.from(byId.values());
    }

    function score(st) {
      const email = (st.email || "").toLowerCase();
      const f = (st.fName || "").toLowerCase();
      const l = (st.lName || "").toLowerCase();
      const full = (f && l) ? (f + " " + l) : (f || l);
      let s = 0;
      if (email === q) s += 1000;
      if (full === q)  s += 900;
      if (full.startsWith(q)) s += 150;
      tokens.forEach(t => {
        if (f.startsWith(t)) s += 60;
        if (l.startsWith(t)) s += 60;
        if (email.includes(t)) s += 60;
      });
      if (!st.isArchived) s += 5;
      if (ym) {
        const { endYear } = parseGroupYears(st.group);
        if (endYear === parseInt(ym[0],10)) s += 120;
      }
      return s;
    }

    const suggestions = students
      .map(st => ({
        _score: score(st),
        label: [st.fName, st.lName].filter(Boolean).join(" ") || st.email,
        subtitle: (st.group ? `Group ${st.group}` : ""),
        email: st.email,
        isArchived: !!st.isArchived
      }))
      .sort((a,b)=> b._score - a._score)
      .slice(0, 8)
      .map(({_score, ...rest}) => rest);

    return res.json({ ok: true, suggestions });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


// --- Admin: Update basic fields (name, school, group, isLyte, archive toggle) ---
app.post("/admin/students/:email/update", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    const patch = {
      fName: (req.body.fName||"").trim(),
      lName: (req.body.lName||"").trim(),
      school: (req.body.school||"").trim(),
      group: (req.body.group||"").trim(),
      isLyte: req.body.isLyte === "on",
    };
    if (req.body.archive === "on") {
      patch.isArchived = true; patch.archivedAt = new Date();
    } else if (req.body.archive === "off") {
      patch.isArchived = false; patch.archivedAt = null;
    }
    await Student.updateOne({ email }, { $set: patch });
    res.redirect(req.get("Referer") || ("/admin/students/" + encodeURIComponent(email)));
  } catch (e) { return errorPage(res, e); }
});

//students can only confirm when the switch is ON
app.post("/confirm", async function(req, res) {
  const userEmail = _.toLower(req.body.userEmail || "");

  try {
    const ctrl = await Control.findOne({ id: 1 }).lean();
    if (!ctrl || ctrl.confirmationsEnabled !== true) {
      return renderHome(res, userEmail, "Confirmations are not open right now.");
    }

    await Confirm.updateOne(
      { email: userEmail },
      { $set: { confirmed: true } },
      { upsert: true }
    );

    const now = new Date();
    const season = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    await snapshotConfirmedSlotsToArchive(userEmail, season);

    return renderHome(res, userEmail, "Successfully confirmed your slots.");
  } catch (err) {
    return errorPage(res, err);
  }
});

// Admin: snapshot ALL currently confirmed students' claims to archivedSlots
app.post("/admin/archive-confirmed-sweep", async function(req, res) {
  try {
    const confirmed = await Confirm.find({ confirmed: true }).lean();
    const now = new Date();
    const season = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    let total = 0;
    for (const c of confirmed) {
      const email = (c.email || "").toLowerCase();
      if (!email) continue;
      const { upserted } = await snapshotConfirmedSlotsToArchive(email, season);
      total += upserted;
    }
    return renderAdminHome(res, `Archived snapshot complete. New records inserted: ${total}.`);
  } catch (err) {
    return errorPage(res, err);
  }
});

// --- Admin: Add a slot to this student (claim) ---
app.post("/admin/students/:email/add-slot", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    const st = await Student.findOne({ email }).lean();
    if (!st) return errorPage(res, "Student not found");
    await Slot.updateOne(
      { _id: req.body.slotId, $or: [{ studentEmail: { $exists: false } }, { studentEmail: "" }, { studentEmail: null }] },
      { $set: { studentEmail: email, studentName: [st.fName, st.lName].filter(Boolean).join(" ") } }
    );
    res.redirect(req.get("Referer") || ("/admin/students/" + encodeURIComponent(email)));
  } catch (e) { return errorPage(res, e); }
});

app.post("/admin/archive/by-grad-year", async function(req, res) {
  try {
    const gradYear = parseInt(req.body.gradYear, 10);
    if (!gradYear) return renderAdminHome(res, "Please provide a valid graduation year.");

    // Fetch only non-archived; parse their group; archive those with endYear === gradYear
    const candidates = await Student.find({ isArchived: { $ne: true } }).select("email group").lean();
    const emails = candidates
      .filter(s => parseGroupYears(s.group).endYear === gradYear)
      .map(s => (s.email || "").toLowerCase());

    if (!emails.length) return renderAdminHome(res, `No students matched graduation year ${gradYear}.`);

    const { modifiedCount } = await Student.updateMany(
      { email: { $in: emails } },
      { $set: { isArchived: true, archivedAt: new Date() } }
    );

    if (modifiedCount === 0) return renderAdminHome(res, `No students were archived for "${group}".`);

    return renderAdminHome(res, `${modifiedCount} student(s) archived for graduation year ${gradYear}.`);
    

  } catch (e) {
    return errorPage(res, e);
  }
});


app.post("/admin/archive/group", async function(req, res) {
  try {
    const group = (req.body.group || "").trim();
    if (!group) return renderAdminHome(res, "Please provide a group string (e.g., 2025-2027).");

    const { modifiedCount } = await Student.updateMany(
      { group, isArchived: { $ne: true } },
      { $set: { isArchived: true, archivedAt: new Date() } }
    );
    
    if (modifiedCount === 0) return renderAdminHome(res, `No students were archived for "${group}".`);

    return renderAdminHome(res, `${modifiedCount} student(s) archived in group "${group}".`);

  } catch (e) {
    return errorPage(res, e);
  }
});

// --- Admin: Remove a slot from this student (unclaim) ---
app.post("/admin/students/:email/remove-slot", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    await Slot.updateOne(
      { _id: req.body.slotId, studentEmail: email },
      { $unset: { studentEmail: "", studentName: "" } }
    );
    res.redirect(req.get("Referer") || ("/admin/students/" + encodeURIComponent(email)));
  } catch (e) { return errorPage(res, e); }
});

// --- Admin: Reset / toggle confirmation for this student ---
app.post("/admin/students/:email/reset-confirm", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    if (req.body.action === "clear") {
      await Confirm.updateOne({ email }, { $unset: { confirmed: "" } }, { upsert: true });
    } else if (req.body.action === "confirm") {
      await Confirm.updateOne({ email }, { $set: { confirmed: true } }, { upsert: true });

      // snapshot on admin-driven confirm as well
      const now = new Date();
      const season = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      await snapshotConfirmedSlotsToArchive(email, season);
    }
    res.redirect(req.get("Referer") || ("/admin/students/" + encodeURIComponent(email)));
  } catch (e) { return errorPage(res, e); }
});



// Search open slots (AJAX) — returns JSON list of open slots matching q
app.get("/admin/students/:email/open-slots", async function(req, res) {
  try {
    const q = String(req.query.q || "").toLowerCase().trim();
    const open = await Slot.find({
      $or: [{ studentEmail: { $exists: false } }, { studentEmail: "" }, { studentEmail: null }]
    }).lean();

    const filtered = open.filter(sl => {
      if (!q) return false; // <- require a query now; no empty-list dump
      const hay = [
        sl.physName, sl.physSpecialty, sl.location, sl.notes,
        sl.dDate, sl.timeStart, sl.timeEnd
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });

    res.json({ ok: true, results: filtered.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});


// Add an hour adjustment
app.post("/admin/students/:email/hours/add", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    const delta = parseFloat(req.body.deltaHours || "0");
    const reason = (req.body.reason || "").trim();
    if (!delta || !Number.isFinite(delta)) throw new Error("Invalid hour delta");
    await StudentHourLog.create({ studentEmail: email, deltaHours: delta, reason });
    res.redirect(req.get("Referer") || ("/admin/students/" + encodeURIComponent(email)));
  } catch (e) { return errorPage(res, e); }
});

// Remove a specific adjustment
app.post("/admin/students/:email/hours/remove", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    const id = req.body.id;
    await StudentHourLog.deleteOne({ _id: id, studentEmail: email });
    res.redirect(req.get("Referer") || ("/admin/students/" + encodeURIComponent(email)));
  } catch (e) { return errorPage(res, e); }
});

app.get("/admin/students/:email/archives.csv", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    const hist = await ArchivedSlot.find({ studentEmail: email }).sort({ capturedAt: -1 }).lean();

    const rows = [];
    rows.push([
      "Email","Student Name","Physician","Specialty","Date",
      "Start","End","Location","Notes","Hours","Season","ArchivedAt"
    ].join(","));

    hist.forEach(h => {
      const hours = archivedSlotHours(h) || 0;
      const dDate = h.date ? new Date(h.date).toISOString().slice(0,10) : "";
      const escaped = s => {
        const t = (s == null ? "" : String(s));
        return /[",\n]/.test(t) ? `"${t.replace(/"/g,'""')}"` : t;
      };
      rows.push([
        email,
        escaped(h.studentName || ""),
        escaped(h.physName || ""),
        escaped(h.physSpecialty || ""),
        dDate,
        escaped(h.timeStart || ""),
        escaped(h.timeEnd || ""),
        escaped(h.location || ""),
        escaped(h.notes || ""),
        (hours ? hours.toFixed(2) : "0"),
        escaped(h.season || ""),
        h.capturedAt ? new Date(h.capturedAt).toISOString() : ""
      ].join(","));
    });

    const csv = rows.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${encodeURIComponent(email)}-archived-slots.csv`);
    res.send(csv);
  } catch (e) { return errorPage(res, e); }
});

// Create a new slot and assign it to this student
app.post("/admin/students/:email/create-slot", async function(req, res) {
  try {
    const email = _.toLower(req.params.email);
    const st = await Student.findOne({ email }).lean();
    if (!st) return errorPage(res, "Student not found");

    // Build the new slot
    const date = req.body.date ? new Date(req.body.date) : null; // yyyy-mm-dd
    const newSlot = await Slot.create({
      physName: (req.body.physName || "").trim(),
      physSpecialty: (req.body.physSpecialty || "").trim(),
      date,
      timeStart: (req.body.timeStart || "").trim(),
      timeEnd: (req.body.timeEnd || "").trim(),
      location: (req.body.location || "").trim(),
      notes: (req.body.notes || "").trim(),
      studentEmail: email,
      studentName: [st.fName, st.lName].filter(Boolean).join(" ")
    });

    // optional: log it
    makeLog("Admin add slot", email, String(newSlot._id), String(newSlot._id));

    res.redirect(req.get("Referer") || ("/admin/students/" + encodeURIComponent(email)));
  } catch (e) { return errorPage(res, e); }
});

// Update an archived slot
app.post("/admin/archived-slots/:id/update", async function(req, res) {
  try {
    const id = req.params.id;
    const email = _.toLower(req.body.studentEmail || "");
    const patch = {
      physName: (req.body.physName||"").trim(),
      physSpecialty: (req.body.physSpecialty||"").trim(),
      location: (req.body.location||"").trim(),
      notes: (req.body.notes||"").trim(),
      timeStart: (req.body.timeStart||"").trim(),
      timeEnd: (req.body.timeEnd||"").trim()
    };
    // parse date yyyy-mm-dd
    patch.date = req.body.date ? new Date(req.body.date) : null;
    await ArchivedSlot.updateOne({ _id: id, studentEmail: email }, { $set: patch });
    res.redirect(req.get("Referer") || "/admin");
  } catch (e) { return errorPage(res, e); }
});

// Delete an archived slot
app.post("/admin/archived-slots/:id/delete", async function(req, res) {
  try {
    const id = req.params.id;
    const email = _.toLower(req.body.studentEmail || "");
    await ArchivedSlot.deleteOne({ _id: id, studentEmail: email });
    res.redirect(req.get("Referer") || "/admin");
  } catch (e) { return errorPage(res, e); }
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

// Create a new archived slot (manual add)
app.post("/admin/archived-slots/create", async function(req, res) {
  try {
    const email = _.toLower(req.body.studentEmail || "");
    if (!email) throw new Error("Missing studentEmail");
    const st = await Student.findOne({ email }).lean();
    if (!st) throw new Error("Student not found");

    const doc = {
      studentEmail: email,
      studentName: [st.fName, st.lName].filter(Boolean).join(" "),
      physName: (req.body.physName||"").trim(),
      physSpecialty: (req.body.physSpecialty||"").trim(),
      date: req.body.date ? new Date(req.body.date) : null,
      timeStart: (req.body.timeStart||"").trim(),
      timeEnd: (req.body.timeEnd||"").trim(),
      location: (req.body.location||"").trim(),
      notes: (req.body.notes||"").trim(),
      season: (req.body.season||"").trim() || ""
    };
    await ArchivedSlot.create(doc);
    res.redirect(req.get("Referer") || "/admin");
  } catch (e) { return errorPage(res, e); }
});

// Update an archived slot
app.post("/admin/archived-slots/:id/update", async function(req, res) {
  try {
    const id = req.params.id;
    const email = _.toLower(req.body.studentEmail || "");
    const patch = {
      physName: (req.body.physName||"").trim(),
      physSpecialty: (req.body.physSpecialty||"").trim(),
      location: (req.body.location||"").trim(),
      notes: (req.body.notes||"").trim(),
      timeStart: (req.body.timeStart||"").trim(),
      timeEnd: (req.body.timeEnd||"").trim(),
      season: (req.body.season||"").trim()
    };
    patch.date = req.body.date ? new Date(req.body.date) : null;
    await ArchivedSlot.updateOne({ _id: id, studentEmail: email }, { $set: patch });
    res.redirect(req.get("Referer") || "/admin");
  } catch (e) { return errorPage(res, e); }
});

// Delete an archived slot
app.post("/admin/archived-slots/:id/delete", async function(req, res) {
  try {
    const id = req.params.id;
    const email = _.toLower(req.body.studentEmail || "");
    await ArchivedSlot.deleteOne({ _id: id, studentEmail: email });
    res.redirect(req.get("Referer") || "/admin");
  } catch (e) { return errorPage(res, e); }
});


// Activate account with detailed error handling
app.post("/activate-account", async function(req, res) {
  try {
    const email = _.toLower(req.body.email || "").trim();
    const password = req.body.password || "";
    const fName = _.startCase(req.body.fName || "");
    const lName = _.startCase(req.body.lName || "");

    if (!email || !password) {
      return res.render("activate-account", {
        errM: "Please enter both email and password before continuing.",
        errM2: ""
      });
    }

    const foundUser = await Student.findOne({ email });
    if (!foundUser) {
      return res.render("activate-account", {
        errM: "This email is not registered yet. Please wait for an admin to create your account or contact apolloyimde@gmail.com.",
        errM2: ""
      });
    }

    // If account already activated (has first name)
    if (foundUser.fName && foundUser.lName) {
      return res.render("activate-account", {
        errM: "This account has already been activated. Please use the Login page.",
        errM2: ""
      });
    }

    // Archived accounts cannot be reactivated
    if (foundUser.isArchived) {
      return res.render("activate-account", {
        errM: "This account has been archived and cannot be activated. Please contact apolloyimde@gmail.com for help.",
        errM2: ""
      });
    }

    // Compare passwords
    const ok = await bcrypt.compare(password, foundUser.password);
    if (!ok) {
      return res.render("activate-account", {
        errM: "Incorrect password. Please check the activation email or contact apolloyimde@gmail.com for assistance.",
        errM2: ""
      });
    }

    // All good — activate account
    await Student.updateOne(
      { email },
      { $set: { fName, lName } }
    );

    console.log(`[activate] Account activated for ${email}`);
    return renderHome(res, email, "Your account has been successfully activated!");
  } catch (err) {
    console.error("Activation error:", err);
    return res.render("activate-account", {
      errM: "An unexpected error occurred while activating your account. Please try again or contact apolloyimde@gmail.com.",
      errM2: ""
    });
  }
});


// Student login
app.post("/login", function(req,res){
  const email = _.toLower(req.body.email);
  const password = req.body.password;

  Student.findOne({email}, function(err, foundUser){
    if(err) return res.render("login", {errM:"", errM2:"An error occured. Please try again."});
    if(!foundUser) return res.render("login", {errM:"", errM2:"Username or password is incorrect."});
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
// Confirm (sets confirmed flag, greys out button on home)
app.post("/confirm", async function(req, res) {
  const userEmail = _.toLower(req.body.userEmail);

  try {
    // 1) Set confirmed = true
    await Confirm.updateOne(
      { email: userEmail },
      { $set: { confirmed: true } },
      { upsert: true }
    );

    // 2) Snapshot current claims → archivedSlots (idempotent)
    const now = new Date();
    const season = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    await snapshotConfirmedSlotsToArchive(userEmail, season);

    return renderHome(res, userEmail, "Successfully confirmed your slots.");
  } catch (err) {
    return errorPage(res, err);
  }
});

app.post("/admin/toggle-confirmations", async (req, res) => {
  try {
    const enabled = req.body.confirmationsEnabled === "true";
    await Control.updateOne({ id:1 }, { $set: { confirmationsEnabled: enabled } }, { upsert:true });
    return renderAdminHome(res, `Confirmations ${enabled ? "enabled" : "disabled"}.`);
  } catch (e) {
    return errorPage(res, e);
  }
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

// Admin: purge archived slot history for students archived >= 1 year ago
app.post("/admin/purge-archived-history", async function(req, res) {
  try {
    const cutoff = new Date(Date.now() - 365*24*60*60*1000); // ~1 year
    const oldStudents = await Student.find({
      isArchived: true,
      archivedAt: { $lte: cutoff }
    }).select("email").lean();

    const emails = oldStudents.map(s => (s.email || "").toLowerCase());
    if (!emails.length) {
      return renderAdminHome(res, "No archived students older than 1 year.");
    }

    const del = await ArchivedSlot.deleteMany({ studentEmail: { $in: emails } });
    return renderAdminHome(res, `Purged ${del.deletedCount || 0} archived slot record(s) for ${emails.length} student(s).`);
  } catch (e) {
    return errorPage(res, e);
  }
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

// ---- Automated daily purge of old archived history ----
(async () => {
  // run once on boot
  await purgeOldArchivedHistory();

  // then every 24h
  const DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    purgeOldArchivedHistory().catch(err => console.error("[purge] interval error:", err));
  }, DAY_MS);
})();

app.listen(port, function() {
  console.log("Server started!");
});
