import { patcher } from "@vendetta";
import {
  findByName,
  findByProps,
  findByStoreName,
  findByTypeNameAll
} from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { findInReactTree } from "@vendetta/utils";
import { showToast } from "@vendetta/ui/toasts";
import React from "react";

const { View, Text, Pressable } = ReactNative as any;

const SvgModule = findByName("Svg", false);
const Svg = SvgModule?.default;
const Path = SvgModule?.Path;

let unpatches: Array<() => void> = [];

const VoiceStateStore =
  findByStoreName("VoiceStateStore") ??
  findByProps("getVoiceStateForUser");

const ChannelStore =
  findByStoreName("ChannelStore") ??
  findByProps("getChannel");

const VoiceActions =
  findByProps("selectVoiceChannel", "selectChannel") ??
  findByProps("selectVoiceChannel");

const ChannelRouter =
  findByProps("transitionToChannel") ??
  findByProps("goToChannel");

type VoiceIconProps = {
  userId: string;
  size?: number;
  profile?: boolean;
};

function log(...args: unknown[]) {
  console.log("[UserVoiceShowIcons]", ...args);
}

function getVoiceState(userId: string) {
  try {
    return VoiceStateStore?.getVoiceStateForUser?.(userId);
  } catch {
    return null;
  }
}

function getVoiceChannel(channelId: string) {
  try {
    return ChannelStore?.getChannel?.(channelId);
  } catch {
    return null;
  }
}

function openOrJoinVoice(channelId: string) {
  try {
    const channel = getVoiceChannel(channelId);
    const channelName = channel?.name ? `#${channel.name}` : "voice channel";

    if (typeof VoiceActions?.selectVoiceChannel === "function") {
      VoiceActions.selectVoiceChannel(channelId);
      showToast(`Joining ${channelName}`);
      return;
    }

    if (typeof ChannelRouter?.transitionToChannel === "function") {
      ChannelRouter.transitionToChannel(channelId);
      showToast(`Opening ${channelName}`);
      return;
    }

    if (typeof ChannelRouter?.goToChannel === "function") {
      ChannelRouter.goToChannel(channelId);
      showToast(`Opening ${channelName}`);
      return;
    }

    showToast("UserVoiceShow: cannot open voice channel");
  } catch (e) {
    console.error("[UserVoiceShowIcons] open/join failed:", e);
    showToast("UserVoiceShow: open/join failed");
  }
}

function VoiceSvgIcon({
  kind,
  size,
  color
}: {
  kind: "mic" | "mute" | "deaf";
  size: number;
  color: string;
}) {
  if (!Svg || !Path) {
    const fallback = kind === "deaf" ? "🎧" : kind === "mute" ? "🎙̸" : "🎙";
    return (
      <Text
        style={{
          color,
          fontSize: size - 1,
          lineHeight: size + 2
        }}
      >
        {fallback}
      </Text>
    );
  }

  const micPath =
    "M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z";

  const mutePath =
    "M19 11h-1.7c0 .74-.16 1.43-.43 2.05L19 15.18c.63-1.05 1-2.27 1-4.18h-1zM14.98 11.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z";

  const deafPath =
    "M12 3a8 8 0 00-8 8v4a3 3 0 003 3h2v-8H6v-1a6 6 0 0112 0v1h-3v8h2a3 3 0 003-3v-4a8 8 0 00-8-8zM3.27 2L2 3.27 20.73 22 22 20.73 3.27 2z";

  const path = kind === "deaf" ? deafPath : kind === "mute" ? mutePath : micPath;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={path} fill={color} />
    </Svg>
  );
}

function VoiceIndicator({ userId, size = 16, profile = false }: VoiceIconProps) {
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

  React.useEffect(() => {
    const interval = setInterval(forceUpdate, 2500);
    return () => clearInterval(interval);
  }, [userId]);

  const voiceState = getVoiceState(userId);
  const channelId = voiceState?.channelId;

  if (!channelId) return null;

  const isMuted = Boolean(voiceState?.mute || voiceState?.selfMute);
  const isDeaf = Boolean(voiceState?.deaf || voiceState?.selfDeaf);

  const kind = isDeaf ? "deaf" : isMuted ? "mute" : "mic";
  const color = isDeaf || isMuted ? "#ED4245" : "#23A55A";

  return (
    <Pressable
      key={`UserVoiceShowIcons-${userId}`}
      onPress={() => openOrJoinVoice(channelId)}
      style={{
        marginLeft: profile ? 6 : 4,
        marginRight: 2,
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      <View
        style={{
          width: size + 4,
          height: size + 4,
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <VoiceSvgIcon kind={kind} size={size} color={color} />
      </View>
    </Pressable>
  );
}

function hasOurIcon(tree: any) {
  return Boolean(
    findInReactTree(tree, (c: any) =>
      String(c?.key ?? "").startsWith("UserVoiceShowIcons")
    )
  );
}

function pushIconToChildren(target: any, userId: string, key: string, profile = false) {
  if (!target?.props) return false;

  const icon = (
    <VoiceIndicator
      key={key}
      userId={userId}
      size={profile ? 18 : 15}
      profile={profile}
    />
  );

  const children = target.props.children;

  if (Array.isArray(children)) {
    children.push(icon);
    return true;
  }

  target.props.children = [children, icon];
  return true;
}

function patchProfileDisplayName() {
  const DisplayNameModule = findByProps("DisplayName");

  if (!DisplayNameModule?.DisplayName) {
    log("DisplayName module not found; profile icon patch skipped.");
    return;
  }

  unpatches.push(
    patcher.after("DisplayName", DisplayNameModule, ([props], res) => {
      const userId = props?.user?.id;
      if (!userId || !res || hasOurIcon(res)) return;

      const directTarget =
        res?.props?.children?.props?.children?.[0];

      if (pushIconToChildren(directTarget, userId, `UserVoiceShowIcons-profile-${userId}`, true)) {
        return;
      }

      const fallbackTarget = findInReactTree(
        res,
        (c: any) =>
          Array.isArray(c?.props?.children) &&
          c.props.children.some(
            (child: any) =>
              typeof child === "string" ||
              typeof child?.props?.children === "string"
          )
      );

      pushIconToChildren(fallbackTarget, userId, `UserVoiceShowIcons-profile-${userId}`, true);
    })
  );

  log("Patched profile DisplayName.");
}

function patchGuildMemberRows() {
  const Rows = findByProps("GuildMemberRow");

  if (!Rows?.GuildMemberRow) {
    log("GuildMemberRow not found; member list patch skipped.");
    return;
  }

  unpatches.push(
    patcher.after("type", Rows.GuildMemberRow, ([props], res) => {
      const userId = props?.user?.id;
      if (!userId || !res || hasOurIcon(res)) return;

      const row = findInReactTree(
        res,
        (c: any) => c?.props?.style?.flexDirection === "row"
      );

      if (!row?.props?.children) return;

      const icon = (
        <VoiceIndicator
          key={`UserVoiceShowIcons-member-${userId}`}
          userId={userId}
          size={15}
        />
      );

      if (Array.isArray(row.props.children)) {
        row.props.children.splice(2, 0, icon);
      } else {
        row.props.children = [row.props.children, icon];
      }
    })
  );

  log("Patched GuildMemberRow.");
}

function patchUserRows() {
  const UserRows = findByTypeNameAll("UserRow") ?? [];

  if (!UserRows.length) {
    log("UserRow modules not found; user row patch skipped.");
    return;
  }

  for (const UserRow of UserRows) {
    unpatches.push(
      patcher.after("type", UserRow, ([props], res) => {
        const userId =
          props?.user?.id ??
          findInReactTree(res, (c: any) => c?.props?.user?.id)?.props?.user?.id;

        if (!userId || !res || hasOurIcon(res)) return;

        if (res?.props?.label) {
          res.props.label = (
            <View
              key={`UserVoiceShowIcons-userrow-wrap-${userId}`}
              style={{
                flexDirection: "row",
                alignItems: "center"
              }}
            >
              {res.props.label}
              <VoiceIndicator
                key={`UserVoiceShowIcons-userrow-${userId}`}
                userId={userId}
                size={15}
              />
            </View>
          );
        }
      })
    );
  }

  log(`Patched ${UserRows.length} UserRow module(s).`);
}

export default {
  onLoad() {
    if (!VoiceStateStore?.getVoiceStateForUser) {
      showToast("UserVoiceShow Icons: VoiceStateStore not found");
      log("VoiceStateStore not found.");
      return;
    }

    patchProfileDisplayName();
    patchGuildMemberRows();
    patchUserRows();

    showToast("UserVoiceShow Icons loaded");
  },

  onUnload() {
    for (const unpatch of unpatches) {
      try {
        unpatch();
      } catch {}
    }

    unpatches = [];
    showToast("UserVoiceShow Icons unloaded");
  }
};
