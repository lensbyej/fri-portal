import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const trackedGames = [
  {
    name: "S1 Testing",
    placeId: 13532792960,
    universeId: 4704233432,
    url: "https://www.roblox.com/games/13532792960/Dev-Testing",
  },
  {
    name: "S2 Testing",
    placeId: 13196289331,
    universeId: 4603179307,
    url: "https://www.roblox.com/games/13196289331/FRI-S2-Testing",
  },
  {
    name: "Rewrite (Noxies Version)",
    placeId: 133470628457954,
    universeId: 9369507971,
    url: "https://www.roblox.com/games/133470628457954/Rewirte",
  },
  {
    name: "Private Servers",
    placeId: 94464403538690,
    universeId: 9820725880,
    url: "https://www.roblox.com/games/94464403538690/Private-Servers",
  },
];

const trackedTeam = [
  { name: "Noxarien", role: "Co-owner", userId: 1534838663, url: "https://www.roblox.com/users/1534838663/profile" },
  { name: "Berks", role: "Owner", userId: 1634477467, url: "https://www.roblox.com/users/1634477467/profile" },
  { name: "Flash", role: "Developer", userId: 1132319120, url: "https://www.roblox.com/users/1132319120/profile" },
  { name: "Matt", role: "Developer", userId: 982082574, url: "https://www.roblox.com/users/982082574/profile" },
  { name: "Pizza", role: "Developer", userId: 1182441301, url: "https://www.roblox.com/users/1182441301/profile" },
  { name: "Infinate", role: "Developer", userId: 5810514920, url: "https://www.roblox.com/users/5810514920/profile" },
  { name: "Decentclv", role: "Developer", userId: 672288263, url: "https://www.roblox.com/users/672288263/profile" },
];

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    await requireLeadership(request);

    const [games, presences, avatars] = await Promise.all([fetchGames(), fetchPresence(), fetchAvatars()]);

    return json({
      checkedAt: new Date().toISOString(),
      games,
      team: trackedTeam.map((member) => {
        const presence = presences.get(member.userId);
        return {
          ...member,
          avatarUrl: avatars.get(member.userId) ?? "",
          presenceType: presence?.userPresenceType ?? 0,
          status: presenceLabel(presence?.userPresenceType ?? 0),
          lastLocation: presence?.lastLocation || "Website",
          lastOnline: presence?.lastOnline || null,
          placeId: presence?.placeId || null,
          rootPlaceId: presence?.rootPlaceId || null,
          universeId: presence?.universeId || null,
          gameId: presence?.gameId || null,
        };
      }),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Roblox status failed" }, 400);
  }
});

async function requireLeadership(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization) throw new Error("Missing authorization");

  const client = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("Invalid leadership session");
  if (data.user.app_metadata?.fri_role !== "leadership") throw new Error("Leadership role required");
}

async function fetchGames() {
  const universeIds = trackedGames.map((game) => game.universeId).join(",");
  const response = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeIds}`);
  if (!response.ok) throw new Error(`Roblox games API returned ${response.status}`);

  const payload = await response.json();
  const byUniverse = new Map((payload.data || []).map((game: Record<string, unknown>) => [Number(game.id), game]));

  return trackedGames.map((tracked) => {
    const game = byUniverse.get(tracked.universeId) || {};
    return {
      ...tracked,
      robloxName: String(game.name || tracked.name),
      playing: Number(game.playing || 0),
      visits: Number(game.visits || 0),
      maxPlayers: Number(game.maxPlayers || 0),
      updated: game.updated || null,
      created: game.created || null,
    };
  });
}

async function fetchPresence() {
  const response = await fetch("https://presence.roblox.com/v1/presence/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userIds: trackedTeam.map((member) => member.userId) }),
  });
  if (!response.ok) throw new Error(`Roblox presence API returned ${response.status}`);

  const payload = await response.json();
  return new Map((payload.userPresences || []).map((presence: Record<string, unknown>) => [Number(presence.userId), presence]));
}

async function fetchAvatars() {
  const userIds = trackedTeam.map((member) => member.userId).join(",");
  const response = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds}&size=150x150&format=Png&isCircular=false`,
  );
  if (!response.ok) return new Map<number, string>();

  const payload = await response.json();
  return new Map((payload.data || []).map((avatar: Record<string, unknown>) => [Number(avatar.targetId), String(avatar.imageUrl || "")]));
}

function presenceLabel(type: number) {
  if (type === 1) return "Online";
  if (type === 2) return "In Experience";
  if (type === 3) return "In Studio";
  return "Offline";
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
