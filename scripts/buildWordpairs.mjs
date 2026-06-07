// Build script for src/games/undercover/wordpairs.js.
//
// Merges three sources into one deduped array of { a, b, cat } pairs:
//   1. MASJV/undercover-game words.json     (MIT, 6 categories)
//   2. antebrl/undercover-word-game EN list (MIT, ~293 tuple pairs)
//   3. ~300 authored Indian-context pairs   (this file, AUTHORED below)
//
// The app must NOT fetch at runtime: this script emits a static module.
// Run: node scripts/buildWordpairs.mjs
//
// Source resolution order for the two external lists:
//   • local clone at /tmp/MASJV_undercover-game/ and /tmp/gh_undercover/
//   • else fetch the raw GitHub URL.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "games", "undercover", "wordpairs.js");

const MASJV_LOCAL = "/tmp/MASJV_undercover-game/words.json";
const MASJV_URL = "https://raw.githubusercontent.com/MASJV/undercover-game/master/words.json";
const ANTEBRL_LOCAL = "/tmp/gh_undercover/src/i18n/locales/en/wordPairs.ts";
const ANTEBRL_URL = "https://raw.githubusercontent.com/antebrl/undercover-word-game/master/src/i18n/locales/en/wordPairs.ts";

async function loadText(localPath, url) {
  if (existsSync(localPath)) {
    return { text: await readFile(localPath, "utf8"), from: "local" };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return { text: await res.text(), from: "remote" };
}

// ── source 1: MASJV words.json ──────────────────────────────────────────
async function loadMasjv() {
  const { text, from } = await loadText(MASJV_LOCAL, MASJV_URL);
  const data = JSON.parse(text);
  const pairs = [];
  for (const [cat, block] of Object.entries(data)) {
    if (!block || !Array.isArray(block.pairs)) continue;
    for (const p of block.pairs) {
      if (typeof p?.c === "string" && typeof p?.m === "string") {
        pairs.push({ a: p.c.trim(), b: p.m.trim(), cat });
      }
    }
  }
  return { pairs, from };
}

// ── source 2: antebrl wordPairs.ts (array of ["A","B"] tuples) ───────────
async function loadAntebrl() {
  const { text, from } = await loadText(ANTEBRL_LOCAL, ANTEBRL_URL);
  const pairs = [];
  // Match ["X", "Y"] tuples, tolerant of single/double quotes & whitespace.
  const re = /\[\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    pairs.push({ a: m[1].trim(), b: m[2].trim(), cat: "general" });
  }
  return { pairs, from };
}

// ── source 3: authored Indian-context pairs ──────────────────────────────
// Rules: same category, overlapping clues, NOT synonyms, NOT obscure,
// distinguishable by 2-3 attributes.
const AUTHORED = [
  // ── indian-food ──────────────────────────────────────────────────────
  ["Chai", "Filter Coffee", "indian-food"],
  ["Biryani", "Pulao", "indian-food"],
  ["Samosa", "Spring Roll", "indian-food"],
  ["Dosa", "Uttapam", "indian-food"],
  ["Idli", "Dhokla", "indian-food"],
  ["Naan", "Roti", "indian-food"],
  ["Paratha", "Kulcha", "indian-food"],
  ["Paneer", "Tofu", "indian-food"],
  ["Gulab Jamun", "Rasgulla", "indian-food"],
  ["Jalebi", "Imarti", "indian-food"],
  ["Lassi", "Buttermilk", "indian-food"],
  ["Pani Puri", "Bhel Puri", "indian-food"],
  ["Vada Pav", "Pav Bhaji", "indian-food"],
  ["Rajma", "Chole", "indian-food"],
  ["Dal Makhani", "Dal Tadka", "indian-food"],
  ["Butter Chicken", "Chicken Tikka", "indian-food"],
  ["Tandoori Chicken", "Chicken 65", "indian-food"],
  ["Kheer", "Phirni", "indian-food"],
  ["Halwa", "Sheera", "indian-food"],
  ["Ladoo", "Barfi", "indian-food"],
  ["Kachori", "Mathri", "indian-food"],
  ["Poha", "Upma", "indian-food"],
  ["Khichdi", "Pongal", "indian-food"],
  ["Aloo Tikki", "Cutlet", "indian-food"],
  ["Masala Dosa", "Rava Dosa", "indian-food"],
  ["Medu Vada", "Bonda", "indian-food"],
  ["Sambar", "Rasam", "indian-food"],
  ["Coconut Chutney", "Tomato Chutney", "indian-food"],
  ["Papad", "Khakhra", "indian-food"],
  ["Pickle", "Murabba", "indian-food"],
  ["Kulfi", "Falooda", "indian-food"],
  ["Modak", "Puran Poli", "indian-food"],
  ["Misal Pav", "Usal", "indian-food"],
  ["Thepla", "Khandvi", "indian-food"],
  ["Litti Chokha", "Sattu Paratha", "indian-food"],
  ["Rogan Josh", "Korma", "indian-food"],
  ["Hyderabadi Biryani", "Lucknowi Biryani", "indian-food"],
  ["Fish Curry", "Prawn Curry", "indian-food"],
  ["Egg Curry", "Egg Bhurji", "indian-food"],
  ["Chana Masala", "Kadai Paneer", "indian-food"],
  ["Palak Paneer", "Matar Paneer", "indian-food"],
  ["Aloo Gobi", "Aloo Matar", "indian-food"],
  ["Baingan Bharta", "Bhindi Masala", "indian-food"],
  ["Malai Kofta", "Veg Kofta", "indian-food"],
  ["Shahi Paneer", "Paneer Butter Masala", "indian-food"],
  ["Curd Rice", "Lemon Rice", "indian-food"],
  ["Jeera Rice", "Ghee Rice", "indian-food"],
  ["Appam", "Idiyappam", "indian-food"],
  ["Puttu", "Pathiri", "indian-food"],
  ["Dhansak", "Sali Boti", "indian-food"],
  ["Vindaloo", "Sorpotel", "indian-food"],
  ["Sevpuri", "Dahi Puri", "indian-food"],
  ["Frankie", "Kathi Roll", "indian-food"],
  ["Maggi", "Pasta", "indian-food"],
  ["Bun Maska", "Brun Maska", "indian-food"],
  ["Sol Kadhi", "Kokum Sharbat", "indian-food"],
  ["Mysore Pak", "Soan Papdi", "indian-food"],
  ["Sandesh", "Mishti Doi", "indian-food"],
  ["Rabri", "Basundi", "indian-food"],
  ["Gajar Halwa", "Moong Dal Halwa", "indian-food"],
  ["Aam Panna", "Jaljeera", "indian-food"],
  ["Nimbu Pani", "Rooh Afza", "indian-food"],
  ["Masala Chai", "Green Tea", "indian-food"],
  ["Tea", "Coffee", "indian-food"],
  ["Sugarcane Juice", "Coconut Water", "indian-food"],
  ["Dabeli", "Kachori", "indian-food"],
  ["Chakli", "Sev", "indian-food"],
  ["Murukku", "Mixture", "indian-food"],

  // ── bollywood ─────────────────────────────────────────────────────────
  ["Shah Rukh Khan", "Salman Khan", "bollywood"],
  ["Amitabh Bachchan", "Dharmendra", "bollywood"],
  ["Aamir Khan", "Akshay Kumar", "bollywood"],
  ["Ranbir Kapoor", "Ranveer Singh", "bollywood"],
  ["Hrithik Roshan", "Tiger Shroff", "bollywood"],
  ["Deepika Padukone", "Priyanka Chopra", "bollywood"],
  ["Alia Bhatt", "Kareena Kapoor", "bollywood"],
  ["Madhuri Dixit", "Sridevi", "bollywood"],
  ["Katrina Kaif", "Kangana Ranaut", "bollywood"],
  ["Ajay Devgn", "Sunny Deol", "bollywood"],
  ["Govinda", "Mithun Chakraborty", "bollywood"],
  ["Nawazuddin Siddiqui", "Pankaj Tripathi", "bollywood"],
  ["Irrfan Khan", "Naseeruddin Shah", "bollywood"],
  ["Rajkummar Rao", "Ayushmann Khurrana", "bollywood"],
  ["Anushka Sharma", "Vidya Balan", "bollywood"],
  ["Sholay", "Deewar", "bollywood"],
  ["Dilwale Dulhania Le Jayenge", "Kuch Kuch Hota Hai", "bollywood"],
  ["3 Idiots", "Taare Zameen Par", "bollywood"],
  ["Lagaan", "Swades", "bollywood"],
  ["Gully Boy", "Zindagi Na Milegi Dobara", "bollywood"],
  ["Bahubali", "RRR", "bollywood"],
  ["Dangal", "Sultan", "bollywood"],
  ["PK", "OMG Oh My God", "bollywood"],
  ["Andaz Apna Apna", "Hera Pheri", "bollywood"],
  ["Munna Bhai MBBS", "Lage Raho Munna Bhai", "bollywood"],
  ["Kabhi Khushi Kabhie Gham", "Kabhi Alvida Naa Kehna", "bollywood"],
  ["Devdas", "Bajirao Mastani", "bollywood"],
  ["Gangs of Wasseypur", "Sacred Games", "bollywood"],
  ["Mughal-e-Azam", "Pakeezah", "bollywood"],
  ["Suraiya", "Madhubala", "bollywood"],
  ["Lata Mangeshkar", "Asha Bhosle", "bollywood"],
  ["Kishore Kumar", "Mohammed Rafi", "bollywood"],
  ["Arijit Singh", "Sonu Nigam", "bollywood"],
  ["A R Rahman", "Pritam", "bollywood"],
  ["Karan Johar", "Sanjay Leela Bhansali", "bollywood"],

  // ── cricket ───────────────────────────────────────────────────────────
  ["Sachin Tendulkar", "Sourav Ganguly", "cricket"],
  ["Virat Kohli", "Rohit Sharma", "cricket"],
  ["MS Dhoni", "Rahul Dravid", "cricket"],
  ["Kapil Dev", "Sunil Gavaskar", "cricket"],
  ["Jasprit Bumrah", "Mohammed Shami", "cricket"],
  ["Ravindra Jadeja", "Ravichandran Ashwin", "cricket"],
  ["Yuvraj Singh", "Suresh Raina", "cricket"],
  ["Hardik Pandya", "Shardul Thakur", "cricket"],
  ["KL Rahul", "Shikhar Dhawan", "cricket"],
  ["Shubman Gill", "Rishabh Pant", "cricket"],
  ["Anil Kumble", "Harbhajan Singh", "cricket"],
  ["Zaheer Khan", "Ishant Sharma", "cricket"],
  ["VVS Laxman", "Mohammad Azharuddin", "cricket"],
  ["Chennai Super Kings", "Mumbai Indians", "cricket"],
  ["Royal Challengers Bengaluru", "Kolkata Knight Riders", "cricket"],
  ["Rajasthan Royals", "Delhi Capitals", "cricket"],
  ["IPL", "Ranji Trophy", "cricket"],
  ["Test Match", "ODI", "cricket"],
  ["T20", "The Hundred", "cricket"],
  ["Wankhede Stadium", "Eden Gardens", "cricket"],
  ["Chinnaswamy Stadium", "Feroz Shah Kotla", "cricket"],
  ["Yorker", "Bouncer", "cricket"],
  ["Googly", "Doosra", "cricket"],
  ["Cover Drive", "Pull Shot", "cricket"],
  ["Helicopter Shot", "Switch Hit", "cricket"],
  ["Slip", "Gully", "cricket"],
  ["LBW", "Run Out", "cricket"],
  ["Century", "Half Century", "cricket"],
  ["No Ball", "Wide", "cricket"],
  ["Wicketkeeper", "Fielder", "cricket"],

  // ── festivals ─────────────────────────────────────────────────────────
  ["Diwali", "Dussehra", "festivals"],
  ["Holi", "Lohri", "festivals"],
  ["Eid", "Bakrid", "festivals"],
  ["Raksha Bandhan", "Bhai Dooj", "festivals"],
  ["Ganesh Chaturthi", "Navratri", "festivals"],
  ["Durga Puja", "Kali Puja", "festivals"],
  ["Onam", "Pongal", "festivals"],
  ["Baisakhi", "Makar Sankranti", "festivals"],
  ["Janmashtami", "Ram Navami", "festivals"],
  ["Karva Chauth", "Teej", "festivals"],
  ["Christmas", "Easter", "festivals"],
  ["Gurpurab", "Mahavir Jayanti", "festivals"],
  ["Chhath Puja", "Govardhan Puja", "festivals"],
  ["Ugadi", "Gudi Padwa", "festivals"],
  ["Bihu", "Lohri", "festivals"],
  ["Mahashivratri", "Hartalika Teej", "festivals"],
  ["Vasant Panchami", "Basant", "festivals"],
  ["Diya", "Candle", "festivals"],
  ["Rangoli", "Kolam", "festivals"],
  ["Firecracker", "Sparkler", "festivals"],
  ["Mithai Box", "Dry Fruits", "festivals"],
  ["Mehndi", "Alta", "festivals"],

  // ── desi-life ─────────────────────────────────────────────────────────
  ["Autorickshaw", "Tempo", "desi-life"],
  ["Local Train", "Metro", "desi-life"],
  ["Cycle Rickshaw", "Toto", "desi-life"],
  ["Scooty", "Bullet", "desi-life"],
  ["Ambassador", "Maruti 800", "desi-life"],
  ["Kirana Store", "Supermarket", "desi-life"],
  ["Sabzi Mandi", "Fish Market", "desi-life"],
  ["Dhaba", "Restaurant", "desi-life"],
  ["Tiffin", "Lunchbox", "desi-life"],
  ["Pressure Cooker", "Kadhai", "desi-life"],
  ["Tawa", "Griddle", "desi-life"],
  ["Mortar and Pestle", "Mixer Grinder", "desi-life"],
  ["Charpai", "Diwan", "desi-life"],
  ["Mosquito Coil", "Mosquito Net", "desi-life"],
  ["Ceiling Fan", "Cooler", "desi-life"],
  ["Inverter", "Generator", "desi-life"],
  ["Geyser", "Immersion Rod", "desi-life"],
  ["Saree", "Lehenga", "desi-life"],
  ["Kurta", "Sherwani", "desi-life"],
  ["Salwar Kameez", "Anarkali", "desi-life"],
  ["Dupatta", "Stole", "desi-life"],
  ["Bindi", "Sindoor", "desi-life"],
  ["Bangles", "Anklet", "desi-life"],
  ["Turban", "Pagri", "desi-life"],
  ["Dhoti", "Lungi", "desi-life"],
  ["Chappal", "Juttis", "desi-life"],
  ["Coconut Tree", "Banyan Tree", "desi-life"],
  ["Peacock", "Parrot", "desi-life"],
  ["Cow", "Buffalo", "desi-life"],
  ["Monsoon", "Summer", "desi-life"],
  ["Ration Card", "Aadhaar Card", "desi-life"],
  ["PAN Card", "Voter ID", "desi-life"],
  ["UPI", "Net Banking", "desi-life"],
  ["Paytm", "PhonePe", "desi-life"],
  ["Doordarshan", "All India Radio", "desi-life"],
  ["Cricket", "Kabaddi", "desi-life"],
  ["Carrom", "Ludo", "desi-life"],
  ["Kho Kho", "Gilli Danda", "desi-life"],
  ["Antakshari", "Dumb Charades", "desi-life"],
  ["Engineering", "Medical", "desi-life"],
  ["IIT", "IIM", "desi-life"],
  ["UPSC", "NEET", "desi-life"],
  ["Coaching Class", "Tuition", "desi-life"],
  ["Wedding", "Engagement", "desi-life"],
  ["Sangeet", "Mehndi Ceremony", "desi-life"],
  ["Baraat", "Vidaai", "desi-life"],
  ["Pandit", "Maulvi", "desi-life"],
  ["Temple", "Gurudwara", "desi-life"],
  ["Mosque", "Church", "desi-life"],
  ["Bollywood", "Tollywood", "desi-life"],
  ["Cha Cha", "Mama", "desi-life"],
  ["Dadi", "Nani", "desi-life"],
  ["Aunty", "Uncle", "desi-life"],
  ["Watchman", "Maali", "desi-life"],
  ["Maid", "Cook", "desi-life"],
  ["Milkman", "Newspaper Boy", "desi-life"],
  ["Dhobi", "Press Wala", "desi-life"],
  ["Roadside Chaiwala", "Coffee Cafe", "desi-life"],
  ["Paan", "Supari", "desi-life"],
  ["Agarbatti", "Dhoop", "desi-life"],
  ["Haldi", "Kumkum", "desi-life"],
  ["Tulsi Plant", "Money Plant", "desi-life"],
  ["Cricket Bat", "Hockey Stick", "desi-life"],
  ["Slate", "Notebook", "desi-life"],
  ["School Uniform", "PT Dress", "desi-life"],
  ["Boards Exam", "Unit Test", "desi-life"],
  ["Summer Vacation", "Diwali Holidays", "desi-life"],

  // ── indian-food (more) ────────────────────────────────────────────────
  ["Chicken Curry", "Mutton Curry", "indian-food"],
  ["Keema", "Kheema Pav", "indian-food"],
  ["Galouti Kebab", "Seekh Kebab", "indian-food"],
  ["Shami Kebab", "Reshmi Kebab", "indian-food"],
  ["Biryani Rice", "Fried Rice", "indian-food"],
  ["Veg Pulao", "Tawa Pulao", "indian-food"],
  ["Dum Aloo", "Aloo Dum", "indian-food"],
  ["Veg Manchurian", "Gobi Manchurian", "indian-food"],
  ["Hakka Noodles", "Schezwan Noodles", "indian-food"],
  ["Chilli Chicken", "Chilli Paneer", "indian-food"],
  ["Momos", "Spring Roll", "indian-food"],
  ["Thukpa", "Ramen", "indian-food"],
  ["Sabudana Khichdi", "Sabudana Vada", "indian-food"],
  ["Methi Thepla", "Aloo Paratha", "indian-food"],
  ["Gobi Paratha", "Paneer Paratha", "indian-food"],
  ["Stuffed Capsicum", "Stuffed Brinjal", "indian-food"],
  ["Veg Biryani", "Egg Biryani", "indian-food"],
  ["Mango Lassi", "Sweet Lassi", "indian-food"],
  ["Thandai", "Sherbet", "indian-food"],
  ["Boondi Raita", "Cucumber Raita", "indian-food"],
  ["Mixed Veg", "Navratan Korma", "indian-food"],
  ["Veg Cutlet", "Veg Roll", "indian-food"],
  ["Cheese Toast", "Bread Pakora", "indian-food"],
  ["Onion Pakora", "Mirchi Bajji", "indian-food"],
  ["Aloo Bonda", "Mysore Bonda", "indian-food"],
  ["Set Dosa", "Neer Dosa", "indian-food"],
  ["Egg Roll", "Chicken Roll", "indian-food"],
  ["Tandoori Roti", "Rumali Roti", "indian-food"],
  ["Missi Roti", "Makki Roti", "indian-food"],
  ["Bajra Roti", "Jowar Roti", "indian-food"],

  // ── bollywood (more) ──────────────────────────────────────────────────
  ["Saif Ali Khan", "Abhishek Bachchan", "bollywood"],
  ["John Abraham", "Arjun Rampal", "bollywood"],
  ["Varun Dhawan", "Sidharth Malhotra", "bollywood"],
  ["Kartik Aaryan", "Vicky Kaushal", "bollywood"],
  ["Shahid Kapoor", "Emraan Hashmi", "bollywood"],
  ["Sonam Kapoor", "Shraddha Kapoor", "bollywood"],
  ["Jacqueline Fernandez", "Disha Patani", "bollywood"],
  ["Tabu", "Konkona Sen Sharma", "bollywood"],
  ["Boman Irani", "Paresh Rawal", "bollywood"],
  ["Anil Kapoor", "Jackie Shroff", "bollywood"],
  ["Aishwarya Rai", "Rani Mukerji", "bollywood"],
  ["Juhi Chawla", "Kajol", "bollywood"],
  ["Rekha", "Hema Malini", "bollywood"],
  ["Dev Anand", "Raj Kapoor", "bollywood"],
  ["Dilip Kumar", "Raaj Kumar", "bollywood"],
  ["Sunny Deol", "Bobby Deol", "bollywood"],
  ["Farhan Akhtar", "Zoya Akhtar", "bollywood"],
  ["Rohit Shetty", "Anurag Kashyap", "bollywood"],
  ["Yash Chopra", "Aditya Chopra", "bollywood"],
  ["Barfi", "Rockstar", "bollywood"],
  ["Queen", "Tanu Weds Manu", "bollywood"],
  ["Drishyam", "Kahaani", "bollywood"],
  ["Andhadhun", "Badla", "bollywood"],
  ["Stree", "Bhediya", "bollywood"],
  ["Dil Chahta Hai", "Rang De Basanti", "bollywood"],
  ["Border", "LOC Kargil", "bollywood"],
  ["Don", "Race", "bollywood"],
  ["Dhoom", "Bang Bang", "bollywood"],
  ["Krrish", "Ra One", "bollywood"],
  ["Singham", "Dabangg", "bollywood"],

  // ── cricket (more) ────────────────────────────────────────────────────
  ["Gautam Gambhir", "Virender Sehwag", "cricket"],
  ["Ajinkya Rahane", "Cheteshwar Pujara", "cricket"],
  ["Mohammed Siraj", "Umesh Yadav", "cricket"],
  ["Kuldeep Yadav", "Yuzvendra Chahal", "cricket"],
  ["Washington Sundar", "Axar Patel", "cricket"],
  ["Sanju Samson", "Ishan Kishan", "cricket"],
  ["Surya Kumar Yadav", "Tilak Varma", "cricket"],
  ["Sunrisers Hyderabad", "Punjab Kings", "cricket"],
  ["Gujarat Titans", "Lucknow Super Giants", "cricket"],
  ["World Cup", "Champions Trophy", "cricket"],
  ["Asia Cup", "Border Gavaskar Trophy", "cricket"],
  ["Spinner", "Pacer", "cricket"],
  ["Opener", "Finisher", "cricket"],
  ["All Rounder", "Specialist Batsman", "cricket"],
  ["Stump", "Bail", "cricket"],
  ["Sixer", "Boundary", "cricket"],
  ["Maiden Over", "Powerplay", "cricket"],
  ["Reverse Swing", "Off Spin", "cricket"],
  ["Square Cut", "Late Cut", "cricket"],
  ["Hook Shot", "Sweep Shot", "cricket"],
  ["Third Umpire", "On Field Umpire", "cricket"],
  ["DRS Review", "No Ball Check", "cricket"],
  ["Net Practice", "Match Day", "cricket"],
  ["Helmet", "Pads", "cricket"],
  ["Gloves", "Abdomen Guard", "cricket"],

  // ── festivals (more) ──────────────────────────────────────────────────
  ["Maha Shivaratri", "Janmashtami", "festivals"],
  ["Sankranti", "Pongal", "festivals"],
  ["Vishu", "Ugadi", "festivals"],
  ["Poila Boishakh", "Bihu", "festivals"],
  ["Dhanteras", "Bhai Dooj", "festivals"],
  ["Lakshmi Puja", "Saraswati Puja", "festivals"],
  ["Garba", "Dandiya", "festivals"],
  ["Ramadan", "Muharram", "festivals"],
  ["Good Friday", "Palm Sunday", "festivals"],
  ["Buddha Purnima", "Guru Purnima", "festivals"],
  ["Hanuman Jayanti", "Krishna Janmashtami", "festivals"],
  ["Akshaya Tritiya", "Gudi Padwa", "festivals"],
  ["Karthika Deepam", "Diwali", "festivals"],
  ["Onam Sadhya", "Pongal Feast", "festivals"],
  ["Pookalam", "Rangoli", "festivals"],

  // ── desi-life (more) ──────────────────────────────────────────────────
  ["Petrol Pump", "CNG Station", "desi-life"],
  ["Toll Plaza", "Check Post", "desi-life"],
  ["Sleeper Coach", "AC Coach", "desi-life"],
  ["Volvo Bus", "State Transport Bus", "desi-life"],
  ["Activa", "Splendor", "desi-life"],
  ["Tata Nano", "Maruti Alto", "desi-life"],
  ["Big Bazaar", "DMart", "desi-life"],
  ["Mall", "Bazaar", "desi-life"],
  ["Street Vendor", "Hawker", "desi-life"],
  ["Roadside Stall", "Food Truck", "desi-life"],
  ["Lassi Shop", "Juice Center", "desi-life"],
  ["Sweet Shop", "Bakery", "desi-life"],
  ["Barber Shop", "Salon", "desi-life"],
  ["STD Booth", "Cyber Cafe", "desi-life"],
  ["Medical Store", "Pharmacy", "desi-life"],
  ["Post Office", "Bank Branch", "desi-life"],
  ["Government School", "Private School", "desi-life"],
  ["Hostel", "PG Accommodation", "desi-life"],
  ["Joint Family", "Nuclear Family", "desi-life"],
  ["Arranged Marriage", "Love Marriage", "desi-life"],
  ["Dowry", "Stridhan", "desi-life"],
  ["Naming Ceremony", "Mundan", "desi-life"],
  ["Housewarming", "Bhoomi Pooja", "desi-life"],
  ["Pooja Room", "Mandir Corner", "desi-life"],
  ["Aarti", "Bhajan", "desi-life"],
  ["Prasad", "Bhog", "desi-life"],
  ["Kalash", "Diya Stand", "desi-life"],
  ["Conch Shell", "Bell", "desi-life"],
  ["Cricket Commentary", "Radio Show", "desi-life"],
  ["Saas Bahu Serial", "Reality Show", "desi-life"],
  ["Doordarshan News", "Cable TV", "desi-life"],
  ["Filmfare Award", "National Award", "desi-life"],
  ["Holi Colors", "Diwali Lights", "desi-life"],
  ["Water Tanker", "Borewell", "desi-life"],
  ["Load Shedding", "Power Cut", "desi-life"],
  ["Monsoon Flooding", "Heatwave", "desi-life"],
  ["Sugarcane Field", "Paddy Field", "desi-life"],
  ["Mango Orchard", "Coconut Grove", "desi-life"],
  ["Bullock Cart", "Tractor", "desi-life"],
  ["Village Well", "Hand Pump", "desi-life"],
];

// ── merge + dedup ─────────────────────────────────────────────────────────
// Two pairs are duplicates if they share the same unordered set of normalized
// words, regardless of category or A/B order.
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}
function pairKey(p) {
  return [norm(p.a), norm(p.b)].sort().join("|");
}
function isValidPair(p) {
  if (!p.a || !p.b) return false;
  if (norm(p.a) === norm(p.b)) return false; // same word both sides
  if (!norm(p.a) || !norm(p.b)) return false;
  return true;
}

async function main() {
  const masjv = await loadMasjv();
  const antebrl = await loadAntebrl();
  const authored = AUTHORED.map(([a, b, cat]) => ({ a, b, cat }));

  const sources = [
    { name: "MASJV", pairs: masjv.pairs, from: masjv.from },
    { name: "antebrl", pairs: antebrl.pairs, from: antebrl.from },
    { name: "authored", pairs: authored, from: "local" },
  ];

  const seen = new Set();
  const merged = [];
  const perSource = {};
  for (const src of sources) {
    let added = 0;
    for (const p of src.pairs) {
      if (!isValidPair(p)) continue;
      const k = pairKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push({ a: p.a, b: p.b, cat: p.cat });
      added += 1;
    }
    perSource[src.name] = { raw: src.pairs.length, added, from: src.from };
  }

  const header = `// AUTO-GENERATED by scripts/buildWordpairs.mjs — DO NOT EDIT BY HAND.
// Run \`node scripts/buildWordpairs.mjs\` to regenerate.
//
// Word pairs for the UNDERCOVER game. Each entry is { a, b, cat } where a/b are
// the two related-but-distinct secret words and cat is a category slug.
//
// ── ATTRIBUTION ──────────────────────────────────────────────────────────
//   • MASJV/undercover-game (MIT License) — https://github.com/MASJV/undercover-game
//   • antebrl/undercover-word-game (MIT License) — https://github.com/antebrl/undercover-word-game
//   • plus ~${authored.length} Indian-context pairs authored for this project.
//
// Totals: ${merged.length} pairs after dedup.
//   MASJV:    ${perSource.MASJV.added} (of ${perSource.MASJV.raw})
//   antebrl:  ${perSource.antebrl.added} (of ${perSource.antebrl.raw})
//   authored: ${perSource.authored.added} (of ${perSource.authored.raw})
`;

  const body =
    "export const WORD_PAIRS = [\n" +
    merged
      .map((p) => `  ${JSON.stringify(p)},`)
      .join("\n") +
    "\n];\n\nexport default WORD_PAIRS;\n";

  await writeFile(OUT, header + "\n" + body, "utf8");

  console.log("Wrote", OUT);
  console.table(perSource);
  console.log("TOTAL pairs:", merged.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
