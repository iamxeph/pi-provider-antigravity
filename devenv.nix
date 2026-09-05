{ pkgs, lib, config, inputs, ... }:

{
  packages = [
    pkgs.git
    pkgs.mitmproxy
    pkgs.jq
  ];

  languages.javascript = {
    enable = true;
    npm.enable = true;
  };
  languages.typescript.enable = true;
}
