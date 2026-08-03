// thatmob_behaviors.js (for Bedrock 1.26.30)
// Verity companion: follow owner, gift, taunt detection, assist on combat, angry->hide->horror->chase->apologize.
// REQUIRE: Experimental Scripting API enabled.

let system = server.registerSystem(0, 0);

const CONFIG = {
  followTeleportDist: 8.0,
  followCheckIntervalTicks: 10,
  teleportBehindDist: 2.5,
  teleportCooldownTicks: 600,
  angryDurationTicks: 20 * 30,
  dayLengthTicks: 24000,
  nightStart: 13000,
  nightEnd: 23000,
  horrorChaseIntervalTicks: 6,
  giftItems: [ "minecraft:iron_sword", "minecraft:golden_apple" ],
  profanityList: ["fuck","đụ","đm","đmm","ngu","địt","địt mẹ","đồ ngu","con chó","đồ mất dạy"],
  // tuning
  chaseDamageEffect: { name: "instant_damage", duration: 1, amplifier: 0 }
};

system.initialize = function() {
  this.listenForEvent("minecraft:player_joined", (e) => this.onPlayerJoin(e));
  this.listenForEvent("minecraft:tick", (e) => this.onTick(e));
  // try hydrating common hurt events (some names vary by version)
  try { this.listenForEvent("minecraft:entity_hurt", (e) => this.onEntityHurt(e)); } catch(e){}
  try { this.listenForEvent("minecraft:entity_damaged", (e) => this.onEntityHurt(e)); } catch(e){}
  // register commands
  this.registerCommand("thatmob_spawn", { description: "Spawn Verity", permission: 0, overloads: [] }, (cmd) => this.cmdSpawn(cmd));
  this.registerCommand("gift", { description: "Request a gift from Verity", permission: 0, overloads: [] }, (cmd) => this.cmdGift(cmd));
  this.registerCommand("taunt", { description: "Taunt Verity with text (detect profanity)", permission: 0, overloads: [{ parameters: [{ name: "text", type: "string", optional: false }] }] }, (cmd) => this.cmdTaunt(cmd));
  this.registerCommand("helpme", { description: "Call Verity to attack nearest hostile to you", permission: 0, overloads: [] }, (cmd) => this.cmdHelpme(cmd));
  this.registerCommand("protecttoggle", { description: "Toggle Verity protective mode", permission: 0, overloads: [] }, (cmd) => this.cmdProtectToggle(cmd));

  this.owners = {}; // playerName -> state object
  this.worldTick = 0;
  this.prepPhrases();
  this.log("thatmob_behaviors initialized.");
};

system.log = function(msg) {
  try { this.executeCommand(`tellraw @a {"rawtext":[{"text":"§6[thatmob] §r${msg}"}]}`); } catch(e){}
};

system.exec = function(cmd, cb) {
  try { this.executeCommand(cmd, cb ? cb : () => {}); } catch(e){}
};

// Player join: create owner record, spawn Verity, gift
system.onPlayerJoin = function(e) {
  let player = e.player; if (!player) return;
  let pid = this.getComponent(player, "minecraft:player_identity"); if (!pid || !pid.name) return;
  let name = pid.name;
  if (!this.owners[name]) {
    this.owners[name] = {
      companionTag: `companion_of_${name}`,
      state: "calm", // calm | angry | hidden | horror | apologizing
      angryUntilTick: 0,
      hidden: false,
      lastHorrorTick: 0,
      protected: true
    };
    this.spawnCompanion(name);
    this.giveGifts(name);
    this.sendToPlayer(name, this.randomCalm());
  }
};

// spawn near player and tag companion
system.spawnCompanion = function(playerName) {
  this.exec(`execute "${playerName}" ~ ~ ~ summon thatmob:verity`);
  this.exec(`execute "${playerName}" ~ ~ ~ tag @e[type=thatmob:verity, distance=..5, sort=nearest, limit=1] add companion_of_${playerName}`);
  this.sendToPlayer(playerName, "Verity đã xuất hiện — tao ở bên mày.");
};

// gifts
system.giveGifts = function(playerName) {
  CONFIG.giftItems.forEach(it => this.exec(`give "${playerName}" ${it} 1`));
  this.sendToPlayer(playerName, this.randomGift());
};

// commands
system.cmdSpawn = function(cmd) {
  let s = cmd.source; if (!s || !s.player) return;
  let name = this.getComponent(s.player, "minecraft:player_identity").name;
  this.spawnCompanion(name);
};
system.cmdGift = function(cmd) {
  let s = cmd.source; if (!s || !s.player) return;
  let name = this.getComponent(s.player, "minecraft:player_identity").name;
  this.giveGifts(name);
};
system.cmdTaunt = function(cmd) {
  let s = cmd.source; if (!s || !s.player) return;
  let name = this.getComponent(s.player, "minecraft:player_identity").name;
  let text = "";
  if (cmd.arguments && cmd.arguments.length > 0) text = cmd.arguments[0];
  text = String(text).toLowerCase();
  if (this.containsProfanity(text)) {
    this.sendToPlayer(name, this.randomAngry());
    this.triggerAnger(name);
  } else {
    this.sendToPlayer(name, this.randomReply());
  }
};
system.cmdHelpme = function(cmd) {
  let s = cmd.source; if (!s || !s.player) return;
  let name = this.getComponent(s.player, "minecraft:player_identity").name;
  this.performProtect(name);
};
system.cmdProtectToggle = function(cmd) {
  let s = cmd.source; if (!s || !s.player) return;
  let name = this.getComponent(s.player, "minecraft:player_identity").name;
  if (!this.owners[name]) return;
  this.owners[name].protected = !this.owners[name].protected;
  this.sendToPlayer(name, `Bảo vệ: ${this.owners[name].protected ? "ON" : "OFF"}`);
};

// profanity detection
system.containsProfanity = function(text) {
  if (!text) return false;
  for (let p of CONFIG.profanityList) if (text.indexOf(p) !== -1) return true;
  return false;
};

// trigger anger -> hide
system.triggerAnger = function(playerName) {
  let rec = this.owners[playerName]; if (!rec) return;
  rec.state = "angry"; rec.angryUntilTick = this.worldTick + CONFIG.angryDurationTicks; rec.hidden = true;
  this.exec(`tag @e[type=thatmob:verity,tag=${rec.companionTag}] add temp_hidden_${playerName}`);
  this.exec(`tp @e[type=thatmob:verity,tag=temp_hidden_${playerName}] 5000 5000 5000`);
  this.sendToPlayer(playerName, this.randomHide());
};

// perform protect action (attack nearest hostile)
system.performProtect = function(playerName) {
  let rec = this.owners[playerName]; if (!rec || !rec.protected) return;
  this.exec(`execute "${playerName}" ~ ~ ~ effect @e[type=!player, distance=..20, sort=nearest, limit=1] instant_damage 1 0`);
  this.sendToPlayer(playerName, this.randomProtect());
};

// companion assist attack: teleport companion near target and deal damage attempt
system.companionAssistAttack = function(playerName, selectorAroundOwner) {
  let rec = this.owners[playerName]; if (!rec) return;
  try {
    // teleport companion to nearest target around owner (selectorAroundOwner like 'distance=..6')
    this.exec(`execute "${playerName}" ~ ~ ~ tp @e[type=thatmob:verity,tag=${rec.companionTag},limit=1] @e[type=!player,${selectorAroundOwner},sort=nearest,limit=1]`);
    this.exec(`execute "${playerName}" ~ ~ ~ effect @e[type=!player,${selectorAroundOwner},sort=nearest,limit=1] instant_damage 1 0`);
    this.sendToPlayer(playerName, this.randomProtect());
  } catch(e){}
};

// entity hurt event (best-effort detection)
system.onEntityHurt = function(event) {
  // This payload varies by version. We'll approximate: for each owner, if a mob is close to the owner just after an event,
  // assume that mob attacked the owner and call companion to assist; also if a mob near the owner was recently damaged assume owner attacked it -> assist.
  for (let name in this.owners) {
    let rec = this.owners[name];
    if (!rec) continue;
    let players = this.getEntitiesFromQuery(`@e[type=player,name="${name}"]`);
    if (!players || players.length===0) continue;
    // if any non-player entity within 6 blocks, assume combat
    let mobs = this.getEntitiesFromQuery(`@e[type=!player, distance=..6, sort=nearest, limit=1]`);
    if (mobs && mobs.length>0) {
      // call companion to assist that mob
      this.companionAssistAttack(name, "distance=..6");
    }
  }
};

// Enforce follow and horror lifecycle
system.enforceFollows = function() {
  for (let name in this.owners) {
    let rec = this.owners[name];
    if (!rec) continue;
    let players = this.getEntitiesFromQuery(`@e[type=player,name="${name}"]`);
    if (!players || players.length===0) continue;
    let playerEnt = players[0];
    // if hidden and angry expired -> at night convert to horror
    if (rec.hidden) {
      if (rec.state==="angry" && this.isNight() && this.worldTick >= rec.angryUntilTick) {
        rec.state = "horror"; rec.hidden=false;
        // replace normal with horror entity
        this.exec(`execute "${name}" ~ ~ ~ summon thatmob:verity_horror`);
        this.exec(`execute "${name}" ~ ~ ~ tag @e[type=thatmob:verity_horror, distance=..3, sort=nearest, limit=1] add ${rec.companionTag}`);
        this.exec(`tag @e[type=thatmob:verity, tag=temp_hidden_${name}] remove temp_hidden_${name}`);
        this.exec(`tellraw "${name}" {"rawtext":[{"text":"§e[Verity] §r${this.randomHorrorStart()}"}]}`);
        // play particle & effects to player
        this.exec(`effect "${name}" blindness 2 0`);
        this.exec(`effect "${name}" nausea 3 0`);
      }
      continue;
    }
    // normal follow enforcement: teleport companion close if far
    let comps = this.getEntitiesFromQuery(`@e[type=thatmob:verity,tag=${rec.companionTag}]`);
    if (comps && comps.length>0) {
      let comp = comps[0];
      let ppos = this.getComponent(playerEnt, "minecraft:position");
      let cpos = this.getComponent(comp, "minecraft:position");
      if (!ppos || !cpos) continue;
      let dx=ppos.x-cpos.x, dy=ppos.y-cpos.y, dz=ppos.z-cpos.z;
      let d2 = dx*dx+dy*dy+dz*dz;
      if (d2 > CONFIG.followTeleportDist*CONFIG.followTeleportDist) {
        let tx = ppos.x - CONFIG.teleportBehindDist;
        let ty = ppos.y;
        let tz = ppos.z;
        this.exec(`execute "${name}" ~ ~ ~ tp @e[type=thatmob:verity,tag=${rec.companionTag},limit=1,sort=nearest] ${tx} ${ty} ${tz}`);
      }
    }
    // if horror state: chase and damage player, stop & apologize if HP low
    let horrors = this.getEntitiesFromQuery(`@e[type=thatmob:verity_horror,tag=${rec.companionTag}]`);
    if (rec.state==="horror" && horrors && horrors.length>0) {
      if (this.worldTick - rec.lastHorrorTick >= CONFIG.horrorChaseIntervalTicks) {
        rec.lastHorrorTick = this.worldTick;
        // teleport horror next to player, damage player
        this.exec(`execute "${name}" ~ ~ ~ tp @e[type=thatmob:verity_horror,tag=${rec.companionTag},limit=1,sort=nearest] ~1 ~ ~1`);
        this.exec(`effect "${name}" instant_damage 1 0`);
        // check player HP
        let hp = 20;
        try {
          let hc = this.getComponent(playerEnt, "minecraft:health");
          if (hc && typeof hc.value==="number") hp = hc.value;
        } catch(e){}
        if (hp <= 4) {
          // stop chase, replace horror with normal verity, apologize
          this.exec(`kill @e[type=thatmob:verity_horror,tag=${rec.companionTag}]`);
          this.exec(`execute "${name}" ~ ~ ~ summon thatmob:verity ~-3 ~ ~-3`);
          this.exec(`execute "${name}" ~ ~ ~ tag @e[type=thatmob:verity, distance=..5, sort=nearest, limit=1] add ${rec.companionTag}`);
          rec.state="calm"; rec.hidden=false;
          this.sendToPlayer(name, this.randomApology());
        }
      }
    }
  }
};

// tick
system.onTick = function(e) {
  this.worldTick++;
  if (this.worldTick % CONFIG.followCheckIntervalTicks === 0) this.enforceFollows();
};

// time helpers
system.getTimeOfDay = function() { return this.worldTick % CONFIG.dayLengthTicks; };
system.isNight = function() { let t = this.getTimeOfDay(); return (t >= CONFIG.nightStart && t <= CONFIG.nightEnd); };

// messaging & phrase generator (tao/mày style)
system.sendToPlayer = function(playerName, text) {
  if (!playerName || !text) return;
  try { this.executeCommand(`tellraw "${playerName}" {"rawtext":[{"text":"§e[Verity] §r${text}"}]}`); } catch(e){}
};

system.prepPhrases = function() {
  this.baseCalm = ["Tao ở đây, mày yên tâm.","Tao sẽ bảo vệ mày.","Đi theo tao, đừng lo."];
  this.baseGift = ["Lấy cái này đi, của tao cho mày.","Đồ này cho mày — cẩn thận nhé."];
  this.baseAngry = ["Mày dám chửi tao à?!","Đừng có động vào tao, mày!","Đồ mất dạy!"];
  this.baseHide = ["Tao biến chút... đừng làm lo.","Tao đi một lát."];
  this.baseHorrorStart = ["Đêm rồi... Verity tao khác rồi.","Đừng ngoảnh mặt, mày sẽ thấy Verity."];
  this.baseApology = ["Xin lỗi mày... Verity quá tay.","Verity xin lỗi, mày bình tĩnh đi."];
  this.baseProtect = ["Verity xử hắn ngay.","Bảo vệ mày là việc của Verity."];
  this.proWords1 = ["đừng","câm","đi"];
  this.proNouns = ["mày","thằng kia","con đó"];
  this.proAdjs = ["ngu","đồ mất dạy","đểu"];
};
system.randomCalm = function(){return this.baseCalm[Math.floor(Math.random()*this.baseCalm.length)];};
system.randomGift = function(){return this.baseGift[Math.floor(Math.random()*this.baseGift.length)];};
system.randomAngry = function(){ if (Math.random()<0.5) return this.baseAngry[Math.floor(Math.random()*this.baseAngry.length)]; return this.generatedInsult(); };
system.randomHide = function(){ return this.baseHide[Math.floor(Math.random()*this.baseHide.length)]; };
system.randomHorrorStart = function(){ return this.baseHorrorStart[Math.floor(Math.random()*this.baseHorrorStart.length)]; };
system.randomApology = function(){ return this.baseApology[Math.floor(Math.random()*this.baseApology.length)]; };
system.randomProtect = function(){ return this.baseProtect[Math.floor(Math.random()*this.baseProtect.length)]; };
system.randomReply = function(){ let r=["Ừm...","Gì thế mày?","Nói nhanh đi"]; return r[Math.floor(Math.random()*r.length)]; };
system.generatedInsult = function(){ let a=this.proWords1[Math.floor(Math.random()*this.proWords1.length)]; let b=this.proNouns[Math.floor(Math.random()*this.proNouns.length)]; let c=this.proAdjs[Math.floor(Math.random()*this.proAdjs.length)]; return `${a} ${b} ${c}!`; };
