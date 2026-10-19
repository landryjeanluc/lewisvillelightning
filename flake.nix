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
            python312
            postgresql
            uv
            imagemagick        # crest extraction, poster crops
            chromium           # headless poster rendering
          ];
          # render/ drives this binary directly rather than downloading one
          CHROME_PATH = "${pkgs.chromium}/bin/chromium";
          # PyAV's bundled FFmpeg libraries need C++ and zlib on NixOS.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib pkgs.zlib ];
          shellHook = ''
            echo "Lewisville Lightning dev shell — node $(node --version), chromium at \$CHROME_PATH"
          '';
        };
      });
    };
}
