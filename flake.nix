{
  description = "Lewisville Lightning — team site, brand assets and game-day poster renderer";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22          # Astro site build
            imagemagick        # crest extraction, poster crops
            chromium           # headless poster rendering
          ];
          # render/ drives this binary directly rather than downloading one
          CHROME_PATH = "${pkgs.chromium}/bin/chromium";
          shellHook = ''
            echo "Lewisville Lightning dev shell — node $(node --version), chromium at \$CHROME_PATH"
          '';
        };
      });
    };
}
