// app.js
const express = require('express');
const ejs = require('ejs');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const _ = require('lodash');
const bcrypt = require('bcrypt');

const saltRounds = 10;
const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const app = express();
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({extended:true}));

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
  timeStart: String,
  physSpecialty:String,
  timeEnd: String,
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
  time:String, type:String, user:String, update:String, slot: String
});
const Log = mongoose.model("Log", logSchema);

// ---- Helpers ----
const ALLOWED_PCP = new Set([
  "Family Medicine (PCP)",
  "Primary Care",
]);
function isPCPSlot(slot) {
  return ALLOWED_PCP.has((slot.physSpecialty || "").trim());
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

function setDisplayValues(slots){
  const sortedSlots = (slots || []).sort((a, b) => (a.date || 0) - (b.date || 0));
  return sortedSlots.map(s => {
    const x = {...s};
    if (x.date) {
      const dt = new Date(x.date);
      x.dDate = `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
    }
    x.isPCP = isPCPSlot(x);
    return x;
  });
}

function errorPage(res, err) {
  return res.render("error", { errM: err?.message || String(err) });
}

// load controls into res.locals if needed elsewhere
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

// ---- Routes ----
// GET
app.get("/", function(req,res){
  res.render("landing");
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
app.get('*', function(req, res) {
  res.redirect('/');
});

// POST
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

    bcrypt.compare(password, foundUser.password, function(err, ok){
      if(err || !ok) return res.render("login", {errM:"", errM2:"Username or password was incorrect."});
      return renderHome(res, foundUser.email, "");
    });
  });
});

// Admin login
app.post("/admin-login", function(req, res) {
  const email = _.toLower(req.body.email);
  const password = req.body.password;

  Admin.findOne({ email }, function(err, foundAdmin) {
    if (err) return res.render("admin-login", { errM: "An error occurred. Please try again." });
    if (!foundAdmin) return res.render("admin-login", { errM: "Email not found." });

    bcrypt.compare(password, foundAdmin.password, function(err, ok) {
      if (err) return res.render("admin-login", { errM: "An error occurred. Please try again." });
      if (!ok) return res.render("admin-login", { errM: "Incorrect password." });

      Slot.find(function(err, slots) {
        if (err) return errorPage(res, err);

        // add display helpers (dDate, isPCP) and sort
        const array = setDisplayValues(slots);

        Confirm.find(function(err, confirms) {
          if (err) return errorPage(res, err);

          res.render("admin-home", {
            slots: array,
            maxSlots: (res.locals.controls && res.locals.controls.maxSlots) || maxSlots,
            allGroups: allGroups.sort(),
            confirms
          });
        });
      });
    });
  });
});

app.post("/claim", function(req,res){
  const userEmail = _.toLower(req.body.userEmail);
  const slotId    = req.body.slotId;

  Control.findOne({ id: 1 }).lean().exec(function(err, ctrl) {
    if (err) return errorPage(res, err);

    // Block adding if matching is locked
    if (ctrl && ctrl.matchingLocked === true) {
      return renderHome(res, userEmail, "Matching is currently locked. You can review/remove your matches but cannot add new ones.");
    }

    Slot.findOne({_id:slotId}, function(err, slot){
      if (err || !slot) return errorPage(res, err || "Slot not found.");

      // Already claimed
      if (slot.studentEmail) {
        return renderHome(res, userEmail, "This slot was already claimed. Please reload to see the latest availability.");
      }

      // Claim it
      Slot.updateOne(
        { _id: slotId },
        { studentName: `${req.body.userFName} ${req.body.userLName}`, studentEmail: userEmail },
        function(err){
          if (err) return errorPage(res, err);
          makeLog("Claim slot", userEmail, slotId, slotId);
          return renderHome(res, userEmail, "Successfully matched.");
        }
      );
    });
  });
});

// Unclaim slot (ALLOWED even when locked, UNLESS already confirmed)
app.post("/unclaim", async function(req, res) {
  const slotId = req.body.slotId;
  const userEmail = _.toLower(req.body.userEmail);

  try {
    // Check if user has confirmed
    const confirmDoc = await Confirm.findOne({ email: userEmail }).lean();
    if (confirmDoc && confirmDoc.confirmed) {
      return renderHome(res, userEmail, "You have already confirmed your slots. You can no longer remove them.");
    }

    // Proceed with removal
    await Slot.updateOne(
      { _id: slotId },
      { studentName: "", studentEmail: "" }
    );

    makeLog("Unclaim", userEmail, slotId, slotId);
    return renderHome(res, userEmail, "Successfully removed slot.");
  } catch (err) {
    return errorPage(res, err);
  }
});

// Confirm slots
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

// Bulk create accounts (admins + students)
app.post("/admin-newAccounts", function(req,res){
  const uploadUserArray = req.body.uploadUsers || "";
  let users = uploadUserArray.split("###").map(x => x.split("///"));

  users.forEach(function(user){
    const email = user[0];
    const password = user[1];
    const group = user[2];
    if(email&&password&&group){
      bcrypt.hash(password,saltRounds,function(err,hashedPassword){
        if(err) return;
        const newStudent = new Student ({
          email:_.toLower(email), password:hashedPassword, group:group
        });
        newStudent.save(()=>{});
      });
    }
  });

  const uploadAdmins = req.body.uploadAdmins || "";
  let admins = uploadAdmins.split("###").map(x => x.split("///"));
  admins.forEach(function(admin){
    const fName = admin[0], lName = admin[1], email = admin[2], password = admin[3];
    if(fName&&lName&&email&&password){
      bcrypt.hash(password,saltRounds,function(err,hashedPassword){
        if(err) return;
        const newAdmin = new Admin ({
          fName, lName, email:_.toLower(email), password:hashedPassword
        });
        newAdmin.save(()=>{});
      });
    }
  });

  res.redirect("/");
});

// Admin: match settings (lock toggle, maxSlots)
app.post("/admin-matchSettings", function(req, res) {
  const maxSlotsValue = parseInt(req.body.maxSlots || maxSlots, 10);
  const lockValue = req.body.matchingLock === "true";

  // remember checked groups (not used elsewhere right now)
  for (let i = 0; i < allGroups.length; i++) {
    const box = req.body[allGroups[i][0]];
    allGroups[i][1] = !!box;
  }

  Control.updateOne(
    { id: 1 },
    { $set: { matchingLocked: lockValue, maxSlots: maxSlotsValue } },
    { upsert: true },
    function(err) {
      if (err) {
        console.error("Error updating Control:", err);
        return res.redirect("/");
      }
      // Optional mirror to students
      Student.updateMany({}, { matchingLocked: lockValue }, function() {
        return res.redirect("/");
      });
    }
  );
});

// ---- Server ----
let port = process.env.PORT;
if(!port) port = 3000;

app.listen(port, function() {
  console.log("Server started!");
});
